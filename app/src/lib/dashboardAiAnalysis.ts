import {
  buildDashboardComparison,
  getDashboardOperationalDate,
  type DashboardComparisonMode,
  type DashboardComparisonResult,
  type DashboardDimension,
  type DashboardDriverContribution,
  type DashboardMetric,
  type DashboardTimeBasis,
  type DashboardTypeFilter,
} from './dashboardAnalysis';
import { resolveCountryForRoute } from './routeCountry';
import { getSupabaseClient } from './supabase';
import { DEFAULT_AI_ANALYSIS_SETTINGS as DEFAULT_SETTINGS_AI_ANALYSIS } from './settingsRules';
import type { AiAnalysisModelSetting, AiAnalysisSettings, FlightRecord, RouteCountryMapping } from './types';
import {
  DASHBOARD_AI_REPORTING_VIEWS,
  inferDashboardAiDataQueryFromPrompt as inferSharedDashboardAiDataQueryFromPrompt,
  isDashboardAiQueryIntentPrompt as isSharedDashboardAiQueryIntentPrompt,
  normalizeDashboardAiPromptForToolRouting as normalizeSharedDashboardAiPromptForToolRouting,
  type DashboardAiDataQuery as SharedDashboardAiDataQuery,
  type DashboardAiQueryCell as SharedDashboardAiQueryCell,
  type DashboardAiQueryMetric as SharedDashboardAiQueryMetric,
  type DashboardAiQueryResult as SharedDashboardAiQueryResult,
  type DashboardAiReportingView as SharedDashboardAiReportingView,
  type DashboardAiToolName as SharedDashboardAiToolName,
} from './dashboardAiShared';

export type DashboardAiProvider = 'gemini' | 'openai-compatible' | 'deepseek';
export type DashboardAiExportTemplateId = 'mom-wow-analysis' | 'sanluong-summary';
export type DashboardAiExportFileName = 'mom-wow-analysis.xlsx' | 'sanluong-summary.xlsx';
export type DashboardAiDataRequestScope = 'records' | 'summary' | 'comparison';
export type DashboardAiToolName = SharedDashboardAiToolName;
export type DashboardVisualReportTemplateId = 'season-overview' | 'driver-waterfall' | 'peak-hour' | 'route-country' | 'airline-mix';
export type DashboardVisualReportBlockType = 'kpi-summary' | 'monthly-trend' | 'driver-waterfall' | 'peak-hour' | 'route-country-ranking' | 'airline-mix-ranking' | 'insight-notes';
export type DashboardVisualReportBlockSource = 'overview' | 'comparison' | 'seasonCatalog' | 'resolvedDataRequest';
export type DashboardAiWorkspaceBlockType = 'kpi' | 'table' | 'chart' | 'insight-list' | 'data-quality-notes' | 'rich-markdown' | 'html-preview';
export type DashboardAiWorkspaceBlockSource = DashboardVisualReportBlockSource | 'multiSeason';
export type DashboardAiWorkspaceChartType = 'bar-ranking' | 'line-trend' | 'waterfall' | 'heatmap' | 'kpi-strip' | 'stacked-bar' | 'area' | 'pie';
export type DashboardAiWorkspaceTableTemplateId = 'season-summary' | 'comparison-drivers' | 'monthly-trend' | 'airline-ranking' | 'route-country-ranking' | 'peak-hour' | 'multi-season-summary' | 'custom-table';
export type DashboardAiToolTraceStatus = 'accepted' | 'rejected' | 'executed' | 'skipped';
export type DashboardAiToolset = 'dashboard-readonly' | 'dashboard-visual' | 'dashboard-export' | 'dashboard-memory';
export type DashboardAiToolRequirement = 'ai_configured' | 'operator_auth' | 'selected_season' | 'local_records' | 'max_3_seasons' | 'export_enabled';
export type DashboardAiToolAvailability = 'enabled' | 'disabled';
export type DashboardAiLanguage = 'vi';
export type DashboardAiContextProfile = 'overview' | 'comparison-drivers' | 'peak-hour' | 'route-country' | 'airline-mix' | 'season-overview' | 'multi-season' | 'validated-sql' | 'eda-profile' | 'data-quality' | 'visualization' | 'answer-verification' | 'safe-rendering'; 
export type DashboardAiWorkflowId =
  | 'peak-day-anomaly'
  | 'day-vs-baseline-drivers'
  | 'month-comparison-drivers'
  | 'route-pax-ranking'
  | 'flight-detail-investigation'
  | 'eda-profile'
  | 'visual-report-builder';
export type DashboardAiWorkflowGate =
  | 'local-sqlite-ready'
  | 'provider-key-ready'
  | 'scope-resolved'
  | 'sql-safety-ready'
  | 'prepared-data-contract-ready'
  | 'render-output-valid';
export type DashboardAiWorkflowQueryPlanKind = 'single-query' | 'multi-query' | 'detail-lookup' | 'profile-only' | 'render-only';
export type DashboardAiWorkflowRenderStrategy = 'daily-anomaly' | 'baseline-drivers' | 'comparison-waterfall' | 'ranking' | 'detail-table' | 'eda-summary' | 'visual-report';
export type DashboardAiWorkflowFallbackPolicy = 'clarify' | 'deterministic-sql' | 'render-query-results-only';

export type DashboardCustomWorkbookCell = string | number | boolean | null;
export type DashboardAiQueryCell = SharedDashboardAiQueryCell;
export type DashboardAiReportingView = SharedDashboardAiReportingView;
export type DashboardAiQueryMetric = SharedDashboardAiQueryMetric;
export type DashboardAiDataSourcePolicy = 'local-sqlite' | 'supabase-reporting' | 'mixed';

export type DashboardAiDataQuery = SharedDashboardAiDataQuery;
export type DashboardAiQueryResult = SharedDashboardAiQueryResult & {
  executedSqlPreview?: string;
};

export interface DashboardAiSqlQueryPlan {
  queryId: string;
  sql: string;
  params: DashboardAiQueryCell[];
  reasonVi: string;
  expectedColumns: string[];
  visualizationHint: DashboardAiWorkspaceChartType | 'table';
  source: DashboardAiDataSourcePolicy;
  workflowId?: DashboardAiWorkflowId | DashboardAiSemanticIntent['workflowId'];
  comparisonKind?: 'period-vs-period' | 'day-vs-baseline' | 'entity-ranking' | 'detail-lookup';
  baseline?: {
    labelVi: string;
    queryId?: string;
  };
  primaryMetric?: DashboardAiQueryMetric | 'delta' | 'delta_pct' | 'delta_vs_baseline';
  primaryDimension?: string;
  renderHints?: {
    titleVi?: string;
    tableTitleVi?: string;
    chartTitleVi?: string;
    x?: string;
    series?: string[];
  };
}

export interface DashboardAiWorkflowDefinition {
  id: DashboardAiWorkflowId;
  descriptionVi: string;
  triggersVi: string[];
  requiredGates: DashboardAiWorkflowGate[];
  queryPlanKind: DashboardAiWorkflowQueryPlanKind;
  renderStrategy: DashboardAiWorkflowRenderStrategy;
  fallbackPolicy: DashboardAiWorkflowFallbackPolicy;
}

export interface DashboardAiPreparedDataContract {
  queryId: string;
  grain: string;
  dateRange?: { from: string; to: string; field: string };
  filters: Record<string, DashboardAiQueryCell | DashboardAiQueryCell[]>;
  metrics: string[];
  dimensions: string[];
  rowCount: number;
  truncated: boolean;
  qualityNotes: string[];
  trusted: boolean;
}

export interface DashboardAiSqlQueryResult extends DashboardAiQueryResult { 
  executedSqlPreview: string; 
} 

export interface DashboardAiSemanticIntent {
  workflowId:
    | 'peak-day-anomaly'
    | 'month-comparison-drivers'
    | 'day-vs-baseline-drivers'
    | 'route-pax-ranking'
    | 'flight-detail-investigation'
    | 'season-to-season-frequency'
    | 'general-query';
  metrics: Array<DashboardAiQueryMetric | 'delta' | 'delta_pct' | 'share'>;
  dimensions: string[];
  dateScope: {
    months?: string[];
    dates?: string[];
    from?: string;
    to?: string;
  };
  comparisonScope?: {
    current?: string;
    previous?: string;
    baseline?: string;
  };
  entities: {
    airlines?: string[];
    routes?: string[];
    countries?: string[];
    aircraft?: string[];
    flightNumbers?: string[];
  };
  requiresBaseline: boolean;
  requiresDrilldown: boolean;
}

export interface DashboardAiResultProfile {
  queryId: string;
  rowCount: number;
  truncated: boolean;
  columns: string[];
  dateCoverage?: { from: string; to: string; field: string };
  nullCounts: Record<string, number>;
  distinctCounts: Record<string, number>;
  metricStats: Record<string, { min: number; max: number; average: number; sum: number }>;
  topValues: Record<string, Array<{ value: string; count: number }>>;
  outlierCandidates: Array<{ column: string; label: string; value: number; reasonVi: string }>;
  dataQualityNotes: string[];
}

export interface DashboardAiAnswerVerification {
  status: 'passed' | 'warning';
  reasonVi: string;
  unsupportedNumbers: string[];
  queryIds: string[];
}

export interface DashboardAiSafeHtmlPreview {
  html: string;
  sanitized: boolean;
  rejectedReason?: string;
}

export type DashboardAiToolTracePhase = 'generated_sql' | 'validated_sql' | 'executed_local_sql' | 'profiled_query_result' | 'verified_answer' | 'rendered_rich_chat' | 'rendered_sandbox_html' | 'rejected_unsafe_render'; 

export interface DashboardAiLocalQuerySeason {
  seasonId: string;
  seasonCode: string;
  records: FlightRecord[];
  dataSource?: 'active' | 'local' | 'cache' | 'server';
  pendingCount?: number;
  total?: number;
  truncated?: boolean;
}

export interface DashboardAiLocalQueryInput {
  seasonRows: DashboardAiLocalQuerySeason[];
  routeCountries?: RouteCountryMapping[] | null;
}

export interface DashboardCustomWorkbookSheet {
  name: string;
  columns: string[];
  rows: Record<string, DashboardCustomWorkbookCell>[];
  notes?: string;
}

export interface DashboardCustomWorkbookSpec {
  title: string;
  sheets: DashboardCustomWorkbookSheet[];
}

export interface DashboardAiToolDefinition {
  name: DashboardAiToolName;
  toolset: DashboardAiToolset;
  requires: DashboardAiToolRequirement[];
  description: string;
  outputContract: string;
  availability?: DashboardAiToolAvailability;
  disabledReason?: string;
}

export interface DashboardAiToolSelectionFixture {
  prompt: string;
  expectedTool: DashboardAiToolName;
  expectedParams: Record<string, string | number | boolean | string[]>;
  tuningSurface: string;
  fixHint: string;
}

export interface DashboardAgentRuntimeConfig {
  ownerWorkflow: 'dashboard-report-analysis';
  maxRounds: number;
  hooks: Array<'ai_configured' | 'operator_auth' | 'selected_season' | 'context_size' | 'allowed_tool_list'>;
  tools: DashboardAiToolDefinition[];
  reportTemplates: DashboardAiExportTemplateId[];
  visualReports: DashboardVisualReportTemplateId[];
}

export interface DashboardAiSkillDefinition { 
  id: 'month-comparison-drivers' | 'day-vs-baseline-drivers' | 'route-pax-ranking' | 'flight-detail-investigation' | 'season-to-season-frequency' | 'peak-hour-analysis' | 'route-country-report' | 'airline-mix-report' | 'season-overview-report' | 'validated-sql-analyst' | 'eda-profile' | 'data-quality-audit' | 'driver-decomposition' | 'visualization-grammar' | 'answer-verification' | 'safe-rendering-policy' | 'supabase-reporting-safety'; 
  descriptionVi: string;
  triggersVi: string[];
  requiredContext: Array<'seasonCatalog' | 'resolvedDataRequest' | 'multiSeason' | 'queryResults'>;
  preferredTool: DashboardAiToolName;
  contextProfile: DashboardAiContextProfile;
  blocks: Array<Partial<DashboardAiWorkspaceBlock>>;
  fallbackBlocks: Array<Partial<DashboardAiWorkspaceBlock>>;
}

export interface DashboardVisualReportBlock {
  id: string;
  type: DashboardVisualReportBlockType;
  title: string;
  source: DashboardVisualReportBlockSource;
  metric?: DashboardMetric;
  dimension?: DashboardDimension;
  limit?: number;
}

export interface DashboardVisualReportSpec {
  templateId: DashboardVisualReportTemplateId;
  title: string;
  filters: DashboardAiFilters;
  blocks: DashboardVisualReportBlock[];
  insights: string[];
  dataQualityNotes: string[];
}

export interface DashboardAiChartSpec {
  chartType: DashboardAiWorkspaceChartType;
  title: string;
  source: DashboardAiWorkspaceBlockSource;
  filters: DashboardAiWorkspaceBlockFilters;
  series: string[];
  limit?: number;
  sourceQueryId?: string;
  x?: string;
  stackBy?: string;
  colorBy?: string;
  rows?: Record<string, DashboardAiQueryCell>[];
}

export interface DashboardAiWorkspaceBlockFilters extends Partial<DashboardAiFilters> {
  currentPeriod?: string;
  previousPeriod?: string;
  currentMonth?: string;
  previousMonth?: string;
}

export interface DashboardAiTableSpec {
  templateId?: DashboardAiWorkspaceTableTemplateId;
  title: string;
  columns: string[];
  source: DashboardAiWorkspaceBlockSource;
  filters: DashboardAiWorkspaceBlockFilters;
  limit?: number;
  sourceQueryId?: string;
  rows?: Record<string, DashboardAiQueryCell>[];
}

export interface DashboardAiRichMarkdownSpec {
  content: string;
}

export interface DashboardAiHtmlPreviewSpec {
  html: string;
  sanitized: boolean;
  rejectedReason?: string;
}

export interface DashboardAiWorkspaceBlock {
  id: string;
  type: DashboardAiWorkspaceBlockType;
  title: string;
  source: DashboardAiWorkspaceBlockSource;
  chart?: DashboardAiChartSpec;
  table?: DashboardAiTableSpec;
  markdown?: DashboardAiRichMarkdownSpec;
  htmlPreview?: DashboardAiHtmlPreviewSpec;
  insights?: string[];
}

export interface DashboardAiBoardPatch {
  title: string;
  blocks: DashboardAiWorkspaceBlock[];
  append: boolean;
}

export interface DashboardAiWorkspaceBoard {
  id: string;
  title: string;
  seasonIds: string[];
  blocks: DashboardAiWorkspaceBlock[];
  createdAt: number;
  updatedAt: number;
}

export interface DashboardAiNotebookCell {
  id: string;
  prompt: string;
  assistantText: string;
  blocks: DashboardAiWorkspaceBlock[];
  toolTraceSummary: DashboardAiToolTraceSummary[];
  exportAction: DashboardAiExportAction | null;
  createdAt: number;
  modelId?: string;
  runEvents?: DashboardAiRunEvent[];
  queryResults?: DashboardAiQueryResult[];
  resultProfiles?: DashboardAiResultProfile[];
  answerVerification?: DashboardAiAnswerVerification;
  activeArtifact?: DashboardAiActiveArtifact | null;
}

export interface DashboardAiNotebook {
  id: string;
  title: string;
  seasonIds: string[];
  cells: DashboardAiNotebookCell[];
  createdAt: number;
  updatedAt: number;
}

export interface DashboardAiNotebookBlockSummary {
  id: string;
  type: DashboardAiWorkspaceBlockType;
  title: string;
  source: DashboardAiWorkspaceBlockSource;
  templateId?: DashboardAiWorkspaceTableTemplateId;
  chartType?: DashboardAiWorkspaceChartType;
  filters?: DashboardAiWorkspaceBlockFilters;
}

export interface DashboardAiNotebookContextCell {
  id: string;
  prompt: string;
  assistantSummary: string;
  blockSummaries: DashboardAiNotebookBlockSummary[];
  toolTraceSummary: DashboardAiToolTraceSummary[];
  createdAt: number;
  modelId?: string;
}

export interface DashboardAiActiveArtifact {
  sourceCellId: string;
  sourceCellIndex?: number;
  queryIds: string[];
  dateRange?: { from?: string; to?: string };
  month?: string;
  seasonIds: string[];
  entities: {
    peakDate?: string;
    metric?: string;
    airlines: string[];
    routes: string[];
    hours: number[];
  };
  blockIds: string[];
  summaryVi: string;
}

export interface DashboardAiNotebookContext {
  cells: DashboardAiNotebookContextCell[];
  capped: boolean;
  activeArtifact?: DashboardAiActiveArtifact;
  activeQuerySample?: DashboardAiQueryResult[];
}

export interface DashboardAiSessionFollowUpResolution {
  sourceCellId: string;
  sourceCellIndex: number;
  activeArtifact: DashboardAiActiveArtifact;
  rewrittenPrompt: string;
  assistantText: string;
  boardPatch?: DashboardAiBoardPatch | null;
  sqlQueryPlans?: DashboardAiSqlQueryPlan[];
}

export interface DashboardAiToolTraceSummary {
  tool: DashboardAiToolName;
  status: DashboardAiToolTraceStatus;
  reason: string;
  phase?: DashboardAiToolTracePhase;
  skill?: string;
  toolset?: DashboardAiToolset;
  fallbackReason?: string;
  contextProfile?: DashboardAiContextProfile;
  providerAttempt?: number;
}

export type DashboardAiRunEventType =
  | 'init'
  | 'user'
  | 'partial_assistant'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'permission_request'
  | 'usage'
  | 'compaction'
  | 'result'
  | 'error'
  | 'skill_invoked'
  | 'skill_completed';

export interface DashboardAiRunEvent {
  id: string;
  runId: string;
  type: DashboardAiRunEventType;
  createdAt: number;
  prompt?: string;
  message?: string;
  tool?: DashboardAiToolName;
  toolset?: DashboardAiToolset;
  status?: DashboardAiToolTraceStatus | 'started' | 'completed' | 'failed';
  reason?: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  skill?: DashboardAiSkillDefinition['id'] | string;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DashboardAiSessionLedger {
  runId: string;
  events: DashboardAiRunEvent[];
  providerView: DashboardAiRunEvent[];
  fullEventCount: number;
  compacted: boolean;
  summaryVi?: string;
}

export interface DashboardAiToolPermissionInput {
  tool: DashboardAiToolName;
  allowedTools: DashboardAiToolName[];
  availableTools?: DashboardAiToolDefinition[];
  readOnly?: boolean;
  requiresConfirmation?: boolean;
  input?: Record<string, unknown>;
}

export interface DashboardAiToolPermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  reasonVi: string;
  readOnly: boolean;
  requiresConfirmation: boolean;
  updatedInput?: Record<string, unknown>;
}

export interface DashboardAiToolScheduleItem {
  id: string;
  tool: DashboardAiToolName;
  input?: Record<string, unknown>;
  parallelSafe?: boolean;
  summarize?: string;
}

export interface DashboardAiToolScheduleResult {
  serial: DashboardAiToolScheduleItem[];
  parallelBatches: DashboardAiToolScheduleItem[][];
  rejected: Array<{ item: DashboardAiToolScheduleItem; reasonVi: string }>;
}

export interface DashboardAiToolAvailabilityInput {
  aiConfigured: boolean;
  operatorAuthorized: boolean;
  hasSelectedSeason: boolean;
  hasLocalRecords: boolean;
  selectedSeasonCount: number;
  exportEnabled: boolean;
}

export interface DashboardAiDataRequest {
  type: 'dashboard-data-request';
  scope: DashboardAiDataRequestScope;
  dateFrom?: string;
  dateTo?: string;
  months?: string[];
  weeks?: string[];
  typeFilter?: DashboardTypeFilter;
  airlines?: string[];
  routes?: string[];
  countries?: string[];
  aircraft?: string[];
  metric?: DashboardMetric;
  dimension?: DashboardDimension;
  maxRecords?: number;
}

export type DashboardAiDataScopeKind =
  | 'active-season'
  | 'selected-seasons'
  | 'full-calendar-month'
  | 'date-range'
  | 'all-seasons-aggregate';

export interface DashboardAiDataScopeSeason {
  seasonId: string;
  seasonCode: string;
  name?: string;
  dateRange: {
    from: string;
    to: string;
  };
}

export interface DashboardAiResolvedDataScope {
  scope: DashboardAiDataScopeKind;
  seasonIds: string[];
  months?: string[];
  dateRange?: {
    from: string;
    to: string;
  };
  explicitSeasonFilter: boolean;
  reason: string;
}

export function resolveDashboardAiDataScopeForPrompt(input: {
  prompt: string;
  activeSeasonId?: string | null;
  selectedSeasonIds?: string[];
  availableSeasonCatalog?: DashboardAiDataScopeSeason[];
}): DashboardAiResolvedDataScope {
  const normalized = normalizePromptForToolRouting(input.prompt);
  const catalog = input.availableSeasonCatalog ?? [];
  const selectedSeasonIds = normalizeDashboardAiScopeSeasonIds(input.selectedSeasonIds ?? [], catalog);
  const activeSeasonId = input.activeSeasonId ?? selectedSeasonIds[0] ?? catalog[0]?.seasonId ?? null;
  const explicitSeasonIds = inferDashboardAiExplicitSeasonIds(normalized, catalog);
  const scopedCatalog = explicitSeasonIds.length > 0
    ? catalog.filter((season) => explicitSeasonIds.includes(season.seasonId))
    : selectedSeasonIds.length > 0
    ? catalog.filter((season) => selectedSeasonIds.includes(season.seasonId))
    : activeSeasonId
    ? catalog.filter((season) => season.seasonId === activeSeasonId)
    : catalog;

  const dateRange = inferDashboardAiScopeDateRange(normalized);
  if (dateRange) {
    return {
      scope: 'date-range',
      seasonIds: explicitSeasonIds.length > 0
        ? explicitSeasonIds
        : resolveDashboardAiSeasonIdsForRange(catalog, dateRange.from, dateRange.to, selectedSeasonIds, activeSeasonId),
      dateRange,
      explicitSeasonFilter: explicitSeasonIds.length > 0,
      reason: explicitSeasonIds.length > 0 ? 'explicit-season-date-range' : 'prompt-date-range',
    };
  }

  const months = inferDashboardAiScopeMonths(normalized, catalog, scopedCatalog);
  if (months.length > 0) {
    const yoyMonths = isDashboardAiYoyScopePrompt(normalized)
      ? normalizeDashboardAiMonthKeys(months.flatMap((monthKey) => [monthKey, shiftDashboardAiMonthKeyYear(monthKey, -1)]))
      : months;
    return {
      scope: explicitSeasonIds.length > 0 ? 'selected-seasons' : 'full-calendar-month',
      seasonIds: explicitSeasonIds.length > 0
        ? explicitSeasonIds
        : resolveDashboardAiSeasonIdsForMonths(catalog, yoyMonths, selectedSeasonIds, activeSeasonId),
      months: yoyMonths,
      explicitSeasonFilter: explicitSeasonIds.length > 0,
      reason: explicitSeasonIds.length > 0 ? 'explicit-season-month' : isDashboardAiYoyScopePrompt(normalized) ? 'yoy-calendar-month' : 'full-calendar-month',
    };
  }

  if (explicitSeasonIds.length > 0) {
    return {
      scope: 'selected-seasons',
      seasonIds: explicitSeasonIds,
      explicitSeasonFilter: true,
      reason: 'explicit-season',
    };
  }

  if (/\b(all data|full data|cross-season|multi-season|toan bo du lieu|tat ca du lieu|tat ca season|all seasons)\b/.test(normalized)) {
    return {
      scope: 'all-seasons-aggregate',
      seasonIds: catalog.length > 0 ? catalog.map((season) => season.seasonId) : selectedSeasonIds,
      explicitSeasonFilter: false,
      reason: 'all-seasons-prompt',
    };
  }

  if (selectedSeasonIds.length > 0) {
    return {
      scope: 'selected-seasons',
      seasonIds: selectedSeasonIds,
      explicitSeasonFilter: false,
      reason: 'selected-ai-seasons',
    };
  }

  return {
    scope: activeSeasonId ? 'active-season' : 'all-seasons-aggregate',
    seasonIds: activeSeasonId ? [activeSeasonId] : catalog.map((season) => season.seasonId),
    explicitSeasonFilter: false,
    reason: activeSeasonId ? 'active-season-fallback' : 'all-seasons-fallback',
  };
}

export interface DashboardAiSummaryRow {
  key: string;
  label: string;
  flights: number;
  pax: number;
  arrivals: number;
  departures: number;
  recordCount: number;
}

export interface DashboardAiSeasonCatalog {
  totalRecords: number;
  dateRange: {
    from: string;
    to: string;
  };
  months: DashboardAiSummaryRow[];
  weeks: DashboardAiSummaryRow[];
  typeTotals: DashboardAiSummaryRow[];
  topAirlines: DashboardAiSummaryRow[];
  topRoutes: DashboardAiSummaryRow[];
  topCountries: DashboardAiSummaryRow[];
  topAircraft: DashboardAiSummaryRow[];
  truncated: {
    topRows: boolean;
  };
}

export interface DashboardAiResolvedDataRequest {
  request: DashboardAiDataRequest;
  totalRecords: number;
  includedRecords: number;
  truncated: boolean;
  records: DashboardAiSelectedRecord[];
  comparison?: DashboardAiResolvedComparison | null;
  aggregations: {
    totals: DashboardAiSummaryRow;
    byMonth: DashboardAiSummaryRow[];
    byWeek: DashboardAiSummaryRow[];
    byDimension: DashboardAiSummaryRow[];
  };
}

export interface DashboardAiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DashboardAiStoredMessage extends DashboardAiChatMessage {
  id: string;
  createdAt: number;
  modelId?: string;
}

export interface DashboardAiFilters {
  comparisonMode: DashboardComparisonMode;
  metric: DashboardMetric;
  typeFilter: DashboardTypeFilter;
  dimension: DashboardDimension;
  timeBasis: DashboardTimeBasis;
}

export interface DashboardAiWaterfallContextRow {
  dimension: DashboardDimension;
  label: string;
  result: DashboardComparisonResult;
  topDriver: DashboardDriverContribution | null;
  reconciledDelta: number;
}

export interface DashboardAiSelectedRecord {
  id: string;
  date: string;
  type: 'A' | 'D';
  airline: string;
  flightNumber: string;
  rawFlightNumber: string;
  route: string;
  schedule: string;
  aircraft: string;
  pax: number | null;
}

export interface DashboardAiResolvedComparison {
  mode: DashboardComparisonMode;
  metric: DashboardMetric;
  dimension: DashboardDimension;
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  currentPeriod: string;
  previousPeriod: string;
  periodLabels: {
    current: string;
    previous: string;
  };
  current: DashboardAiSummaryRow;
  previous: DashboardAiSummaryRow;
  delta: number;
  deltaPct: number | null;
  drivers: DashboardDriverContribution[];
}

export interface DashboardAiContext {
  contextVersion: 2;
  generatedAt: string;
  filters?: DashboardAiFilters;
  comparison?: DashboardComparisonResult;
  seasonCatalog: DashboardAiSeasonCatalog;
  multiSeasonCatalog?: {
    seasonIds: string[];
    seasons: Array<{
      seasonId: string;
      seasonCode: string;
      name: string;
      totalRecords: number;
      totalPax: number;
      dateRange: { from: string; to: string };
      months: number;
    }>;
  } | null;
  availableSeasonCatalog?: Array<{
    seasonId: string;
    seasonCode: string;
    name: string;
    dateRange: { from: string; to: string };
  }>;
  dataScope?: DashboardAiResolvedDataScope;
  dataSourcePolicy?: DashboardAiDataSourcePolicy;
  semanticIntent?: DashboardAiSemanticIntent | null;
  waterfallRows?: DashboardAiWaterfallContextRow[];
  selectedDriver?: DashboardDriverContribution | null;
  selectedDriverRecords?: {
    totalRecords: number;
    includedRecords: number;
    truncated: boolean;
    records: DashboardAiSelectedRecord[];
  };
  resolvedDataRequest?: DashboardAiResolvedDataRequest | null;
}

export interface BuildDashboardAiContextInput {
  comparison?: DashboardComparisonResult | null;
  filters?: DashboardAiFilters;
  waterfallRows?: DashboardAiWaterfallContextRow[];
  selectedDriver?: DashboardDriverContribution | null;
  selectedDriverRecords?: FlightRecord[];
  seasonRecords?: FlightRecord[];
  routeCountries?: RouteCountryMapping[] | null;
  resolvedDataRequest?: DashboardAiResolvedDataRequest | null;
  semanticIntent?: DashboardAiSemanticIntent | null;
  maxSelectedRecords?: number;
  maxCatalogRows?: number;
  now?: Date;
}

export interface DashboardAiRequest {
  userPrompt: string;
  context: DashboardAiContext;
  history?: DashboardAiChatMessage[];
  model: AiAnalysisModelSetting | null | undefined;
  preferredTool?: DashboardAiToolName | null;
  allowDataRequest?: boolean;
  availableTools?: DashboardAiToolDefinition[];
  selectedSkillId?: DashboardAiSkillDefinition['id'] | null;
  contextProfile?: DashboardAiContextProfile | null;
  workflowId?: DashboardAiWorkflowId | DashboardAiSemanticIntent['workflowId'] | string | null;
  preparedDataContracts?: DashboardAiPreparedDataContract[];
  notebookContext?: DashboardAiNotebookContext | null;
  language?: DashboardAiLanguage;
  providerFallback?: boolean;
  localQueryResults?: DashboardAiQueryResult[];
  signal?: AbortSignal;
  localProviderKey?: string | null;
  supabaseClient?: {
    functions: {
      invoke: (functionName: string, options: { body: DashboardAiFunctionRequest }) => Promise<{ data: unknown; error: unknown }>;
    };
  };
}

export interface DashboardAiLocalAgentRequest {
  userPrompt: string;
  model: AiAnalysisModelSetting;
  seasonIds: string[];
  workflowId?: DashboardAiWorkflowId | string | null;
  semanticIntent?: DashboardAiSemanticIntent | null;
  requiredGates?: DashboardAiWorkflowGate[];
  sessionArtifact?: DashboardAiActiveArtifact | Record<string, unknown> | null;
  notebookContext?: DashboardAiNotebookContext | null;
  contextDocuments?: unknown[];
  signal?: AbortSignal;
  localAgentClient: (payload: unknown) => Promise<unknown | null>;
}

export interface DashboardAiFunctionRequest {
  userPrompt: string;
  context: DashboardAiContext;
  history: DashboardAiChatMessage[];
  modelId: string;
  allowedExportActions: DashboardAiExportFileName[];
  allowedTools: DashboardAiToolName[];
  availableTools: DashboardAiToolDefinition[];
  preferredTool?: DashboardAiToolName;
  selectedSkillId?: DashboardAiSkillDefinition['id'];
  contextProfile?: DashboardAiContextProfile;
  workflowId?: DashboardAiWorkflowId | DashboardAiSemanticIntent['workflowId'] | string;
  preparedDataContracts?: DashboardAiPreparedDataContract[];
  notebookContext?: DashboardAiNotebookContext;
  language: DashboardAiLanguage;
  providerFallback: boolean;
  allowedReportTemplates: DashboardAiExportTemplateId[];
  allowedVisualReports: DashboardVisualReportTemplateId[];
  maxRounds: number;
  allowDataRequest: boolean;
  allowCustomWorkbook: boolean;
}

export interface DashboardAiTemplateExportAction {
  type: 'dashboard-template-export';
  templateId: DashboardAiExportTemplateId;
  format: 'xlsx';
  fileName: DashboardAiExportFileName;
}

export interface DashboardAiCustomWorkbookAction {
  type: 'dashboard-custom-workbook';
  format: 'xlsx';
  fileName: string;
  workbookSpec: DashboardCustomWorkbookSpec;
}

export type DashboardAiExportAction = DashboardAiTemplateExportAction | DashboardAiCustomWorkbookAction;

export interface DashboardAiAnalysisResponse { 
  assistantText: string; 
  exportAction: DashboardAiExportAction | null; 
  dataRequest: DashboardAiDataRequest | null; 
  queryResults: DashboardAiQueryResult[]; 
  sqlQueryPlans: DashboardAiSqlQueryPlan[]; 
  resultProfiles?: DashboardAiResultProfile[]; 
  answerVerification?: DashboardAiAnswerVerification; 
  visualReport: DashboardVisualReportSpec | null; 
  boardPatch: DashboardAiBoardPatch | null; 
  toolTraceSummary: DashboardAiToolTraceSummary[]; 
  workflowId?: DashboardAiWorkflowId | string | null;
  preparedDataContracts?: DashboardAiPreparedDataContract[];
  workflowTraceSummary?: DashboardAiToolTraceSummary[];
} 

export interface DashboardAiLocalHistoryOptions {
  maxMessages?: number;
  maxBytes?: number;
}

export class DashboardAiConfigurationError extends Error {
  retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'DashboardAiConfigurationError';
  }
}

export class DashboardAiRequestError extends Error {
  retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'DashboardAiRequestError';
  }
}

export const DASHBOARD_AI_GROUNDING_INSTRUCTIONS = [
  'You are an aviation operations analyst for the Seasonal Management dashboard.',
  'Answer only from the supplied dashboard JSON context.',
  'LuÃ´n tráº£ lá»i báº±ng tiáº¿ng Viá»‡t cho ná»™i dung ngÆ°á»i dÃ¹ng nhÃ¬n tháº¥y.',
  'If the supplied data is insufficient, say what is missing instead of inventing a cause.',
  'When the user asks for a calendar month, YoY, or transition-month view, treat it as the full calendar period represented by dataScope, not only the active season slice.',
  'Reference exact periods, filters, deltas, drivers, and record examples when relevant.',
  'Avoid generic aviation explanations that are not supported by the provided data.',
  'DÃ¹ng vÄƒn phong váº­n hÃ nh ngáº¯n gá»n, rÃµ sá»‘ liá»‡u, giá»¯ nguyÃªn ARR/DEP, KPI, airline code vÃ  route code.',
].join('\n');

const DEFAULT_MAX_SELECTED_RECORDS = 16;
const DEFAULT_MAX_CATALOG_ROWS = 12;
const DEFAULT_MAX_DATA_REQUEST_RECORDS = 200;
const MAX_DATA_REQUEST_RECORDS = 500;
export const DASHBOARD_AI_MAX_ROUNDS = 4;
export const DASHBOARD_AI_REPORT_TEMPLATE_IDS: DashboardAiExportTemplateId[] = ['mom-wow-analysis', 'sanluong-summary'];
export const DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS: DashboardVisualReportTemplateId[] = ['season-overview', 'driver-waterfall', 'peak-hour', 'route-country', 'airline-mix'];
export const DASHBOARD_AI_WORKSPACE_BLOCK_TYPES: DashboardAiWorkspaceBlockType[] = ['kpi', 'table', 'chart', 'insight-list', 'data-quality-notes', 'rich-markdown', 'html-preview'];
export const DASHBOARD_AI_WORKSPACE_CHART_TYPES: DashboardAiWorkspaceChartType[] = ['bar-ranking', 'line-trend', 'waterfall', 'heatmap', 'kpi-strip', 'stacked-bar', 'area', 'pie'];
export const DASHBOARD_AI_WORKSPACE_TABLE_TEMPLATE_IDS: DashboardAiWorkspaceTableTemplateId[] = ['season-summary', 'monthly-trend', 'airline-ranking', 'route-country-ranking', 'peak-hour', 'multi-season-summary', 'custom-table'];
const DEFAULT_DASHBOARD_AI_WORKFLOW_GATES: DashboardAiWorkflowGate[] = [
  'local-sqlite-ready',
  'provider-key-ready',
  'scope-resolved',
  'sql-safety-ready',
  'prepared-data-contract-ready',
  'render-output-valid',
];
export const DASHBOARD_AI_WORKFLOW_REGISTRY: DashboardAiWorkflowDefinition[] = [
  {
    id: 'peak-day-anomaly',
    descriptionVi: 'Tìm ngày cao điểm trong một kỳ và so sánh ngày đó với baseline các ngày còn lại.',
    triggersVi: ['ngày cao điểm', 'cao điểm', 'điểm bất thường', 'so với các ngày còn lại', 'peak day', 'anomaly'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'multi-query',
    renderStrategy: 'daily-anomaly',
    fallbackPolicy: 'deterministic-sql',
  },
  {
    id: 'day-vs-baseline-drivers',
    descriptionVi: 'Phân tích driver của ngày/cell đang tham chiếu so với baseline.',
    triggersVi: ['ngày đó', 'phân tích driver', 'driver ngày', 'bảng trên', 'tiếp tục', 'baseline'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'multi-query',
    renderStrategy: 'baseline-drivers',
    fallbackPolicy: 'render-query-results-only',
  },
  {
    id: 'month-comparison-drivers',
    descriptionVi: 'So sánh hai tháng/kỳ theo airline, route, country, aircraft, type hoặc local hour.',
    triggersVi: ['so sánh tháng', 'tháng', 'khác biệt', 'biến động', 'driver tháng', 'month comparison'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'single-query',
    renderStrategy: 'comparison-waterfall',
    fallbackPolicy: 'deterministic-sql',
  },
  {
    id: 'route-pax-ranking',
    descriptionVi: 'Xếp hạng đường bay theo PAX hoặc số chuyến trong khoảng được hỏi.',
    triggersVi: ['top route', 'route pax', 'pax cao nhất', 'đường bay'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'single-query',
    renderStrategy: 'ranking',
    fallbackPolicy: 'deterministic-sql',
  },
  {
    id: 'flight-detail-investigation',
    descriptionVi: 'Tra cứu chi tiết một ngày bay hoặc một chuyến bay cụ thể.',
    triggersVi: ['thông tin chuyến', 'chi tiết chuyến', 'flight detail', 'ngày bay'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'detail-lookup',
    renderStrategy: 'detail-table',
    fallbackPolicy: 'clarify',
  },
  {
    id: 'eda-profile',
    descriptionVi: 'Lập hồ sơ EDA: coverage, missing/null, phân phối, outlier và top values.',
    triggersVi: ['eda', 'profile', 'missing', 'null', 'outlier', 'chất lượng dữ liệu'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'profile-only',
    renderStrategy: 'eda-summary',
    fallbackPolicy: 'render-query-results-only',
  },
  {
    id: 'visual-report-builder',
    descriptionVi: 'Tạo báo cáo trực quan gồm KPI, bảng, chart và nhận định từ query result đã chuẩn bị.',
    triggersVi: ['báo cáo trực quan', 'visual report', 'dashboard', 'kpi', 'biểu đồ', 'chart'],
    requiredGates: DEFAULT_DASHBOARD_AI_WORKFLOW_GATES,
    queryPlanKind: 'render-only',
    renderStrategy: 'visual-report',
    fallbackPolicy: 'render-query-results-only',
  },
];
export const DASHBOARD_AI_TOOL_REGISTRY: DashboardAiToolDefinition[] = [
  {
    name: 'query_dashboard_data',
    toolset: 'dashboard-readonly',
    requires: ['ai_configured', 'operator_auth', 'selected_season'],
    description: 'DÃ¹ng khi ngÆ°á»i dÃ¹ng há»i thá»‘ng kÃª, so sÃ¡nh, date range, cross-season, hÃ£ng bay, Ä‘Æ°á»ng bay, quá»‘c gia, tÃ u bay, peak hour hoáº·c drilldown tá»« reporting views.',
    outputContract: 'Return DashboardAiDataQuery only; Supabase Edge Function resolves read-only rows from reporting.flight_operations or reporting.summary_* views.',
  },
  {
    name: 'suggest_custom_workbook',
    toolset: 'dashboard-export',
    requires: ['ai_configured', 'operator_auth', 'selected_season', 'local_records', 'export_enabled'],
    description: 'DÃ¹ng khi ngÆ°á»i dÃ¹ng yÃªu cáº§u workbook Excel tÃ¹y chá»‰nh ngoÃ i cÃ¡c máº«u cá»‘ Ä‘á»‹nh.',
    outputContract: 'Return dashboard-custom-workbook with primitive cells only; no formulas, scripts, paths, or external links.',
  },
  {
    name: 'suggest_visual_report',
    toolset: 'dashboard-visual',
    requires: ['ai_configured', 'operator_auth', 'selected_season', 'local_records'],
    description: 'DÃ¹ng khi ngÆ°á»i dÃ¹ng yÃªu cáº§u chart, graph, visualization, visual report, biá»ƒu Ä‘á»“ hoáº·c bÃ¡o cÃ¡o trá»±c quan.',
    outputContract: 'Return DashboardVisualReportSpec using whitelisted visual templates and blocks only.',
  },
  {
    name: 'compose_dashboard_ai_board',
    toolset: 'dashboard-visual',
    requires: ['ai_configured', 'operator_auth', 'selected_season', 'local_records', 'max_3_seasons'],
    description: 'DÃ¹ng khi ngÆ°á»i dÃ¹ng yÃªu cáº§u AI Workspace, báº£ng tráº¯ng, notebook/canvas, multi-block report, multi-season visual analysis.',
    outputContract: 'Return boardPatch with whitelisted board blocks only. Rich markdown is allowed; HTML only through html-preview sandbox block. No scripts, paths, SQL, or writes.',
  },
];
export const DASHBOARD_AI_TOOL_SELECTION_FIXTURES: DashboardAiToolSelectionFixture[] = [
  {
    prompt: 'xuat san luong thang 7 sang Excel',
    expectedTool: 'suggest_custom_workbook',
    expectedParams: { workbook: 'query-backed' },
    tuningSurface: 'query-backed workbook keywords',
    fixHint: 'AI Workspace exports must create custom workbook specs from query results instead of fixed MoM/WoW dashboard templates.',
  },
  {
    prompt: 've peak hour visual report cho thang nay',
    expectedTool: 'suggest_visual_report',
    expectedParams: { templateId: 'peak-hour' },
    tuningSurface: 'visual report keywords',
    fixHint: 'Prioritize chart/visual/ve/bieu do prompts as visual report requests.',
  },
  {
    prompt: 'AI workspace whiteboard compare three seasons',
    expectedTool: 'compose_dashboard_ai_board',
    expectedParams: { seasonLimit: 3 },
    tuningSurface: 'whiteboard workspace keywords',
    fixHint: 'Route board/canvas/whiteboard/multi-season report prompts to compose_dashboard_ai_board.',
  },
  {
    prompt: 'Build visual report in AI Workspace',
    expectedTool: 'compose_dashboard_ai_board',
    expectedParams: { mode: 'board' },
    tuningSurface: 'AI Workspace visual preset keywords',
    fixHint: 'Workspace visual/table/chart presets must create boardPatch blocks, not chat-only visualReport text.',
  },
  {
    prompt: 'so sanh thang 8 VJ ngoai bang hien tai',
    expectedTool: 'query_dashboard_data',
    expectedParams: { months: ['2026-08'], airlines: ['VJ'] },
    tuningSurface: 'broader data request keywords',
    fixHint: 'Route out-of-context months/weeks/date ranges to query_dashboard_data before answering.',
  },
  {
    prompt: 'tao workbook rieng gom airline va route',
    expectedTool: 'suggest_custom_workbook',
    expectedParams: { workbook: 'custom' },
    tuningSurface: 'custom workbook keywords',
    fixHint: 'Separate custom workbook requests from fixed template exports.',
  },
];
export const DASHBOARD_AI_SKILL_REGISTRY: DashboardAiSkillDefinition[] = [
  {
    id: 'month-comparison-drivers',
    descriptionVi: 'PhÃ¢n rÃ£ biáº¿n Ä‘á»™ng giá»¯a hai thÃ¡ng báº±ng truy váº¥n SQLite Ä‘á»™c láº­p theo hÃ£ng bay, Ä‘Æ°á»ng bay hoáº·c dimension ngÆ°á»i dÃ¹ng yÃªu cáº§u.',
    triggersVi: ['so sÃ¡nh thÃ¡ng', 'Ä‘iá»ƒm khÃ¡c biá»‡t', 'biáº¿n Ä‘á»™ng', 'driver', 'waterfall', 'hÃ£ng bay', 'Ä‘Æ°á»ng bay'],
    requiredContext: ['queryResults', 'seasonCatalog'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [
      { type: 'table', title: 'Báº£ng driver so sÃ¡nh thÃ¡ng', source: 'resolvedDataRequest', table: { templateId: 'custom-table', title: 'Báº£ng driver so sÃ¡nh thÃ¡ng', columns: ['dimension', 'current_flights', 'previous_flights', 'delta_flights', 'delta_pct'], source: 'resolvedDataRequest', filters: { metric: 'flights' }, limit: 12 } },
      { type: 'chart', title: 'Waterfall biáº¿n Ä‘á»™ng tá»« query result', source: 'resolvedDataRequest', chart: { chartType: 'waterfall', title: 'Waterfall biáº¿n Ä‘á»™ng tá»« query result', source: 'resolvedDataRequest', filters: { metric: 'flights' }, series: ['delta_flights'], limit: 12 } },
    ],
    fallbackBlocks: [
      { type: 'table', title: 'Báº£ng driver so sÃ¡nh thÃ¡ng', source: 'resolvedDataRequest' },
      { type: 'chart', title: 'Waterfall biáº¿n Ä‘á»™ng tá»« query result', source: 'resolvedDataRequest' },
    ],
  },
  {
    id: 'day-vs-baseline-drivers',
    descriptionVi: 'So sÃ¡nh má»™t ngÃ y vá»›i baseline cÃ¡c ngÃ y cÃ²n láº¡i Ä‘á»ƒ tÃ¬m driver báº¥t thÆ°á»ng.',
    triggersVi: ['ngÃ y Ä‘Ã³', 'so vá»›i cÃ¡c ngÃ y cÃ²n láº¡i', 'driver báº¥t thÆ°á»ng', 'baseline ngÃ y'],
    requiredContext: ['queryResults'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [{ type: 'table', title: 'Driver ngÃ y so vá»›i baseline', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Cáº§n query baseline ngÃ y', source: 'resolvedDataRequest' }],
  },
  {
    id: 'route-pax-ranking',
    descriptionVi: 'Xáº¿p háº¡ng route theo PAX trong khoáº£ng ngÃ y/thÃ¡ng do ngÆ°á»i dÃ¹ng yÃªu cáº§u.',
    triggersVi: ['top route theo PAX', 'route PAX', 'khÃ¡ch theo Ä‘Æ°á»ng bay'],
    requiredContext: ['queryResults'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [{ type: 'table', title: 'Top route theo PAX', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Cáº§n query route/PAX', source: 'resolvedDataRequest' }],
  },
  {
    id: 'flight-detail-investigation',
    descriptionVi: 'Tra cá»©u chi tiáº¿t má»™t ngÃ y bay hoáº·c má»™t chuyáº¿n bay cá»¥ thá»ƒ.',
    triggersVi: ['thÃ´ng tin chuyáº¿n', 'chi tiáº¿t chuyáº¿n bay', 'flight detail'],
    requiredContext: ['queryResults'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [{ type: 'table', title: 'Chi tiáº¿t chuyáº¿n bay', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Cáº§n query chi tiáº¿t chuyáº¿n bay', source: 'resolvedDataRequest' }],
  },
  {
    id: 'season-to-season-frequency',
    descriptionVi: 'So sÃ¡nh táº§n suáº¥t hÃ£ng bay/route giá»¯a cÃ¡c mÃ¹a báº±ng query Ä‘á»™c láº­p.',
    triggersVi: ['so sÃ¡nh mÃ¹a', 'táº§n suáº¥t giá»¯a S', 'frequency season'],
    requiredContext: ['queryResults', 'multiSeason'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'multi-season',
    blocks: [{ type: 'table', title: 'So sÃ¡nh táº§n suáº¥t giá»¯a mÃ¹a', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Cáº§n query cross-season', source: 'resolvedDataRequest' }],
  },
  {
    id: 'peak-hour-analysis',
    descriptionVi: 'Táº¡o biá»ƒu Ä‘á»“ vÃ  báº£ng phÃ¢n tÃ­ch khung giá» cao Ä‘iá»ƒm tá»« dá»¯ liá»‡u dashboard.',
    triggersVi: ['peak hour', 'khung giá» cao Ä‘iá»ƒm', 'giá» cao Ä‘iá»ƒm', 'biá»ƒu Ä‘á»“ giá»'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'peak-hour',
    blocks: [
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ khung giá» cao Ä‘iá»ƒm', source: 'overview', chart: { chartType: 'bar-ranking', title: 'Biá»ƒu Ä‘á»“ khung giá» cao Ä‘iá»ƒm', source: 'overview', filters: { dimension: 'hourBucket', metric: 'flights' }, series: ['flights'], limit: 24 } },
      { type: 'table', title: 'Báº£ng khung giá» cao Ä‘iá»ƒm', source: 'overview', table: { templateId: 'peak-hour', title: 'Báº£ng khung giá» cao Ä‘iá»ƒm', columns: ['label', 'flights'], source: 'overview', filters: { dimension: 'hourBucket', metric: 'flights' }, limit: 24 } },
    ],
    fallbackBlocks: [
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ khung giá» cao Ä‘iá»ƒm', source: 'overview' },
      { type: 'table', title: 'Báº£ng khung giá» cao Ä‘iá»ƒm', source: 'overview' },
    ],
  },
  {
    id: 'route-country-report',
    descriptionVi: 'Táº¡o bÃ¡o cÃ¡o xáº¿p háº¡ng Ä‘Æ°á»ng bay/quá»‘c gia vÃ  nháº­n Ä‘á»‹nh biáº¿n Ä‘á»™ng route.',
    triggersVi: ['Ä‘Æ°á»ng bay', 'route', 'quá»‘c gia', 'country', 'route-country'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'route-country',
    blocks: [
      { type: 'table', title: 'Xáº¿p háº¡ng Ä‘Æ°á»ng bay / quá»‘c gia', source: 'overview', table: { templateId: 'route-country-ranking', title: 'Xáº¿p háº¡ng Ä‘Æ°á»ng bay / quá»‘c gia', columns: ['label', 'flights'], source: 'overview', filters: { dimension: 'route', metric: 'flights' }, limit: 12 } },
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ Ä‘Æ°á»ng bay ná»•i báº­t', source: 'overview', chart: { chartType: 'bar-ranking', title: 'Biá»ƒu Ä‘á»“ Ä‘Æ°á»ng bay ná»•i báº­t', source: 'overview', filters: { dimension: 'route', metric: 'flights' }, series: ['flights'], limit: 12 } },
    ],
    fallbackBlocks: [
      { type: 'table', title: 'Xáº¿p háº¡ng Ä‘Æ°á»ng bay / quá»‘c gia', source: 'overview' },
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ Ä‘Æ°á»ng bay ná»•i báº­t', source: 'overview' },
    ],
  },
  {
    id: 'airline-mix-report',
    descriptionVi: 'Táº¡o bÃ¡o cÃ¡o cÆ¡ cáº¥u hÃ£ng bay, báº£ng xáº¿p háº¡ng hÃ£ng vÃ  biá»ƒu Ä‘á»“ top airline.',
    triggersVi: ['hÃ£ng bay', 'airline', 'airline mix', 'cÆ¡ cáº¥u hÃ£ng'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'airline-mix',
    blocks: [
      { type: 'table', title: 'Xáº¿p háº¡ng hÃ£ng bay', source: 'overview', table: { templateId: 'airline-ranking', title: 'Xáº¿p háº¡ng hÃ£ng bay', columns: ['label', 'flights'], source: 'overview', filters: { dimension: 'airline', metric: 'flights' }, limit: 12 } },
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ cÆ¡ cáº¥u hÃ£ng bay', source: 'overview', chart: { chartType: 'bar-ranking', title: 'Biá»ƒu Ä‘á»“ cÆ¡ cáº¥u hÃ£ng bay', source: 'overview', filters: { dimension: 'airline', metric: 'flights' }, series: ['flights'], limit: 12 } },
    ],
    fallbackBlocks: [
      { type: 'table', title: 'Xáº¿p háº¡ng hÃ£ng bay', source: 'overview' },
      { type: 'chart', title: 'Biá»ƒu Ä‘á»“ cÆ¡ cáº¥u hÃ£ng bay', source: 'overview' },
    ],
  },
  { 
    id: 'season-overview-report', 
    descriptionVi: 'Táº¡o bÃ¡o cÃ¡o tá»•ng quan mÃ¹a gá»“m KPI, xu hÆ°á»›ng thÃ¡ng, báº£ng mÃ¹a vÃ  nháº­n Ä‘á»‹nh.',
    triggersVi: ['tá»•ng quan mÃ¹a', 'season overview', 'bÃ¡o cÃ¡o trá»±c quan', 'visual report', 'workspace board'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'season-overview',
    blocks: [
      { type: 'kpi', title: 'KPI tá»•ng quan', source: 'overview' },
      { type: 'chart', title: 'Xu hÆ°á»›ng chuyáº¿n bay theo thÃ¡ng', source: 'overview', chart: { chartType: 'line-trend', title: 'Xu hÆ°á»›ng chuyáº¿n bay theo thÃ¡ng', source: 'overview', filters: { metric: 'flights' }, series: ['flights'], limit: 12 } },
      { type: 'table', title: 'Báº£ng tá»•ng há»£p mÃ¹a', source: 'multiSeason', table: { templateId: 'season-summary', title: 'Báº£ng tá»•ng há»£p mÃ¹a', columns: ['label', 'flights'], source: 'multiSeason', filters: { metric: 'flights' }, limit: 3 } },
    ],
    fallbackBlocks: [
      { type: 'kpi', title: 'KPI tá»•ng quan', source: 'overview' },
      { type: 'chart', title: 'Xu hÆ°á»›ng chuyáº¿n bay theo thÃ¡ng', source: 'overview' },
      { type: 'table', title: 'Báº£ng tá»•ng há»£p mÃ¹a', source: 'multiSeason' }, 
    ], 
  }, 
  {
    id: 'validated-sql-analyst',
    descriptionVi: 'Sinh kế hoạch SQL SELECT/CTE read-only khi câu hỏi cần dữ liệu chi tiết từ SQLite local.',
    triggersVi: ['sql', 'truy vấn', 'query', 'khoảng ngày', 'từ ngày', 'đến ngày', 'thống kê', 'top 10', 'raw local'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [{ type: 'data-quality-notes', title: 'Kế hoạch SQL read-only', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Kế hoạch SQL read-only', source: 'resolvedDataRequest' }],
  },
  {
    id: 'eda-profile',
    descriptionVi: 'Phân tích EDA: coverage, missing/null, distinct, min/max, top values và outlier candidates.',
    triggersVi: ['eda', 'missing', 'null', 'thiếu dữ liệu', 'phân phối', 'outlier', 'bất thường', 'tổng quan dữ liệu'],
    requiredContext: ['resolvedDataRequest'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'eda-profile',
    blocks: [{ type: 'table', title: 'Hồ sơ EDA', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Ghi chú EDA', source: 'resolvedDataRequest' }],
  },
  {
    id: 'data-quality-audit',
    descriptionVi: 'Kiểm tra chất lượng dữ liệu, scope, field thiếu, dữ liệu bị cap/truncated và nguồn local/remote.',
    triggersVi: ['data quality', 'chất lượng dữ liệu', 'thiếu field', 'truncated', 'bị cap', 'scope', 'nguồn dữ liệu'],
    requiredContext: ['resolvedDataRequest'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'data-quality',
    blocks: [{ type: 'data-quality-notes', title: 'Kiểm tra chất lượng dữ liệu', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Kiểm tra chất lượng dữ liệu', source: 'resolvedDataRequest' }],
  },
  {
    id: 'driver-decomposition',
    descriptionVi: 'Phân rã driver theo airline, route, local hour, ARR/DEP, country hoặc aircraft.',
    triggersVi: ['phân rã', 'driver', 'động lực', 'ngày cao điểm', 'cao điểm', 'so với các ngày còn lại', 'waterfall'],
    requiredContext: ['resolvedDataRequest'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'validated-sql',
    blocks: [{ type: 'table', title: 'Bảng phân rã driver', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'chart', title: 'Waterfall driver', source: 'resolvedDataRequest' }],
  },
  {
    id: 'visualization-grammar',
    descriptionVi: 'Chọn biểu đồ/bảng/KPI phù hợp với ranking, trend, heatmap, waterfall và mix.',
    triggersVi: ['biểu đồ', 'chart', 'visual', 'heatmap', 'bar chart', 'line chart', 'kpi', 'dashboard'],
    requiredContext: ['resolvedDataRequest'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'visualization',
    blocks: [{ type: 'chart', title: 'Biểu đồ theo dữ liệu truy vấn', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'rich-markdown', title: 'Gợi ý trực quan hóa', source: 'resolvedDataRequest' }],
  },
  {
    id: 'answer-verification',
    descriptionVi: 'Kiểm chứng câu trả lời với query result/profile trước khi render cho người dùng.',
    triggersVi: ['kiểm chứng', 'verify', 'đúng không', 'sai số', 'khớp dữ liệu', 'số liệu'],
    requiredContext: ['resolvedDataRequest'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'answer-verification',
    blocks: [{ type: 'data-quality-notes', title: 'Kiểm chứng câu trả lời', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Kiểm chứng câu trả lời', source: 'resolvedDataRequest' }],
  },
  {
    id: 'safe-rendering-policy',
    descriptionVi: 'Chỉ cho HTML/CSS tĩnh trong iframe sandbox; không chạy JS/Python tự do.',
    triggersVi: ['html', 'preview', 'script', 'python', 'javascript', 'iframe', 'sandbox'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'compose_dashboard_ai_board',
    contextProfile: 'safe-rendering',
    blocks: [{ type: 'html-preview', title: 'HTML preview sandbox', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Chính sách render an toàn', source: 'resolvedDataRequest' }],
  },
  {
    id: 'supabase-reporting-safety',
    descriptionVi: 'Dùng Supabase reporting qua RPC allowlist khi dữ liệu remote-safe; không gọi raw reporting schema.',
    triggersVi: ['supabase', 'reporting', 'rpc', 'remote', 'rls', 'security invoker'],
    requiredContext: ['seasonCatalog'],
    preferredTool: 'query_dashboard_data',
    contextProfile: 'data-quality',
    blocks: [{ type: 'data-quality-notes', title: 'Supabase reporting safety', source: 'resolvedDataRequest' }],
    fallbackBlocks: [{ type: 'data-quality-notes', title: 'Supabase reporting safety', source: 'resolvedDataRequest' }],
  },
]; 
export const DASHBOARD_CUSTOM_WORKBOOK_LIMITS = {
  maxSheets: 8,
  maxColumnsPerSheet: 20,
  maxRowsPerWorkbook: 2000,
  maxCellChars: 5000,
};
const DASHBOARD_VISUAL_REPORT_LIMITS = {
  maxBlocks: 8,
  maxInsights: 8,
  maxNotes: 8,
  maxTextChars: 240,
  maxBlockLimit: 24,
};
export const DASHBOARD_AI_WORKSPACE_LIMITS = {
  maxSeasons: 3,
  maxBlocks: 12,
  maxTextChars: 240,
  maxBlockLimit: 24,
  maxSeries: 4,
  maxColumns: 12,
};
export const DASHBOARD_AI_LOCAL_HISTORY_MAX_MESSAGES = 30;
export const DASHBOARD_AI_LOCAL_HISTORY_MAX_BYTES = 100_000;
export const DEFAULT_AI_ANALYSIS_SETTINGS = DEFAULT_SETTINGS_AI_ANALYSIS;
export const DASHBOARD_AI_EXPORT_ACTION_FILENAMES: DashboardAiExportFileName[] = ['mom-wow-analysis.xlsx', 'sanluong-summary.xlsx'];

function workflowById(id: DashboardAiWorkflowId): DashboardAiWorkflowDefinition {
  return DASHBOARD_AI_WORKFLOW_REGISTRY.find((workflow) => workflow.id === id) ?? DASHBOARD_AI_WORKFLOW_REGISTRY[0];
}

export function resolveDashboardAiWorkflowForPrompt(
  prompt: string,
  context: { activeArtifact?: { entities?: Record<string, unknown> } | null } = {}
): DashboardAiWorkflowDefinition | null {
  const normalized = normalizePromptForToolRouting(prompt);
  const rawLower = prompt.toLowerCase();
  const hasActivePeakDate = typeof context.activeArtifact?.entities?.peakDate === 'string';
  if (hasActivePeakDate && /\b(ngay do|ngay nay|bang tren|tiep|tiep tuc|driver|phan tich driver|phan ra|duong bay|route|hang bay)\b/.test(normalized)) {
    return workflowById('day-vs-baseline-drivers');
  }
  if (
    (/\b(cao diem|ngay cao diem|peak day)\b/.test(normalized) || rawLower.includes('cao điểm') || rawLower.includes('ngày cao điểm')) &&
    (/\b(thang|month|so voi cac ngay con lai|bat thuong|anomaly)\b/.test(normalized) || rawLower.includes('tháng') || rawLower.includes('bất thường'))
  ) {
    return workflowById('peak-day-anomaly');
  }
  if (/\b(top|xep hang|ranking)\b/.test(normalized) && /\b(route|duong bay)\b/.test(normalized) && /\b(pax|khach)\b/.test(normalized)) {
    return workflowById('route-pax-ranking');
  }
  if (/\b(thong tin chuyen|chi tiet chuyen|flight detail|flight no|so hieu chuyen|chuyen bay cu the)\b/.test(normalized)) {
    return workflowById('flight-detail-investigation');
  }
  if (/\b(eda|profile|missing|null|outlier|chat luong du lieu|data quality)\b/.test(normalized)) {
    return workflowById('eda-profile');
  }
  if (/\b(bao cao truc quan|visual report|dashboard|kpi|bieu do|chart|graph)\b/.test(normalized)) {
    return workflowById('visual-report-builder');
  }
  if (/\b(so sanh thang|thang \d{1,2}.*thang \d{1,2}|khac biet|bien dong|driver)\b/.test(normalized)) {
    return workflowById('month-comparison-drivers');
  }
  return null;
}

export function buildDashboardAiPreparedDataContracts(
  queryResults: DashboardAiQueryResult[],
  workflow?: DashboardAiWorkflowDefinition | null
): DashboardAiPreparedDataContract[] {
  return queryResults
    .filter((result) => result.rows.length > 0 && result.columns.length > 0)
    .map((result) => {
      const grain = inferDashboardAiPreparedDataGrain(result);
      const metrics = result.columns.filter((column) => isDashboardAiMetricColumn(column));
      const dimensions = result.columns.filter((column) => !metrics.includes(column));
      const dateRange = inferDashboardAiPreparedDateRange(result);
      const qualityNotes = [
        ...result.dataQualityNotes,
        ...(result.truncated ? ['Kết quả đã bị giới hạn số dòng.'] : []),
        ...(workflow ? [`Workflow: ${workflow.id}`] : []),
      ].slice(0, 8);
      return {
        queryId: result.queryId,
        grain,
        ...(dateRange ? { dateRange } : {}),
        filters: {},
        metrics,
        dimensions,
        rowCount: result.rowCount,
        truncated: result.truncated,
        qualityNotes,
        trusted: result.rowCount > 0 && metrics.length > 0 && !result.truncated,
      };
    });
}

function inferDashboardAiPreparedDataGrain(result: DashboardAiQueryResult): string {
  if (result.columns.includes('ops_date')) return 'ops_date';
  if (result.columns.includes('route')) return 'route';
  if (result.columns.includes('airline')) return 'airline';
  if (result.columns.includes('season')) return 'season';
  if (result.columns.includes('local_hour')) return 'local_hour';
  if (result.columns.includes('month')) return 'month';
  return result.columns[0] ?? 'row';
}

function inferDashboardAiPreparedDateRange(result: DashboardAiQueryResult): DashboardAiPreparedDataContract['dateRange'] | null {
  const dateColumn = result.columns.includes('ops_date')
    ? 'ops_date'
    : result.columns.includes('date')
      ? 'date'
      : null;
  if (!dateColumn) return null;
  const values = result.rows
    .map((row) => row[dateColumn])
    .filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
    .sort();
  if (values.length === 0) return null;
  return { from: values[0], to: values[values.length - 1], field: dateColumn };
}

function isDashboardAiMetricColumn(column: string): boolean {
  return /^(flights|pax|arrivals|departures|current_|previous_|delta|delta_|.*_flights|.*_pax|baseline_|peak_)/i.test(column);
}

export function buildDashboardAgentRuntimeConfig(): DashboardAgentRuntimeConfig {
  return {
    ownerWorkflow: 'dashboard-report-analysis',
    maxRounds: DASHBOARD_AI_MAX_ROUNDS,
    hooks: ['ai_configured', 'operator_auth', 'selected_season', 'context_size', 'allowed_tool_list'],
    tools: DASHBOARD_AI_TOOL_REGISTRY,
    reportTemplates: DASHBOARD_AI_REPORT_TEMPLATE_IDS,
    visualReports: DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS,
  };
}

export function resolveDashboardAiAvailableTools(input: DashboardAiToolAvailabilityInput): DashboardAiToolDefinition[] {
  return DASHBOARD_AI_TOOL_REGISTRY.map((tool) => {
    const disabledReason = resolveDashboardAiToolDisabledReason(tool.requires, input);
    return {
      ...tool,
      availability: disabledReason ? 'disabled' : 'enabled',
      ...(disabledReason ? { disabledReason } : {}),
    };
  });
}

function resolveDashboardAiToolDisabledReason(
  requirements: DashboardAiToolRequirement[],
  input: DashboardAiToolAvailabilityInput
): string | null {
  if (requirements.includes('ai_configured') && !input.aiConfigured) return 'ChÆ°a cáº¥u hÃ¬nh model AI kháº£ dá»¥ng.';
  if (requirements.includes('operator_auth') && !input.operatorAuthorized) return 'TÃ i khoáº£n hiá»‡n táº¡i chÆ°a Ä‘Æ°á»£c xÃ¡c thá»±c quyá»n váº­n hÃ nh.';
  if (requirements.includes('selected_season') && !input.hasSelectedSeason) return 'ChÆ°a chá»n mÃ¹a dá»¯ liá»‡u.';
  if (requirements.includes('local_records') && !input.hasLocalRecords) return 'ChÆ°a cÃ³ dá»¯ liá»‡u dashboard local Ä‘á»ƒ phÃ¢n tÃ­ch.';
  if (requirements.includes('max_3_seasons') && input.selectedSeasonCount > DASHBOARD_AI_WORKSPACE_LIMITS.maxSeasons) return 'AI Workspace chá»‰ há»— trá»£ tá»‘i Ä‘a 3 mÃ¹a trong V1.';
  if (requirements.includes('export_enabled') && !input.exportEnabled) return 'ChÆ°a cÃ³ dá»¯ liá»‡u Ä‘á»§ Ä‘iá»u kiá»‡n Ä‘á»ƒ xuáº¥t Excel.';
  return null;
}

export function resolveDashboardAiSkillForPrompt(prompt: string): DashboardAiSkillDefinition | null { 
  const normalized = normalizePromptForToolRouting(prompt); 
  if (/\b(script|javascript|python|html|iframe|sandbox|preview)\b/.test(normalized)) return skillById('safe-rendering-policy');
  const semanticIntent = inferDashboardAiSemanticIntent({ userPrompt: prompt });
  if (semanticIntent.workflowId === 'month-comparison-drivers') return skillById('month-comparison-drivers');
  if (semanticIntent.workflowId === 'route-pax-ranking') return skillById('route-pax-ranking');
  if (semanticIntent.workflowId === 'flight-detail-investigation') return skillById('flight-detail-investigation');
  if (semanticIntent.workflowId === 'season-to-season-frequency') return skillById('season-to-season-frequency');
  if (semanticIntent.workflowId === 'peak-day-anomaly') return skillById('driver-decomposition');
  if (/\b(phan ra|driver|dong luc|ngay cao diem|cao diem|so voi cac ngay con lai|waterfall)\b/.test(normalized)) return skillById('driver-decomposition');
  if (/\b(eda|missing|null|thieu du lieu|phan phoi|outlier|bat thuong|tong quan du lieu)\b/.test(normalized)) return skillById('eda-profile');
  if (/\b(khoang ngay|tu ngay|den ngay|thong ke|top\s*\d+|truy van|query|raw local|sql)\b/.test(normalized)) return skillById('validated-sql-analyst');
  if (/\b(data quality|chat luong du lieu|truncated|bi cap|thieu field|nguon du lieu)\b/.test(normalized)) return skillById('data-quality-audit');
  if (isDifferenceComparisonPrompt(normalized)) return skillById('month-comparison-drivers'); 
  if (isPeakHourPrompt(normalized)) return skillById('peak-hour-analysis'); 
  if (/\b(route|duong bay|quoc gia|country|route-country)\b/.test(normalized)) return skillById('route-country-report'); 
  if (/\b(airline|hang bay|airline mix|co cau hang)\b/.test(normalized)) return skillById('airline-mix-report'); 
  if (/\b(bieu do|chart|visual|heatmap|kpi|truc quan)\b/.test(normalized)) return skillById('visualization-grammar');
  if (/\b(supabase|reporting|rpc|remote|rls|security invoker)\b/.test(normalized)) return skillById('supabase-reporting-safety');
  if (isVisualPrompt(normalized) || isDashboardAiWorkspaceBoardIntent(normalized)) return skillById('season-overview-report'); 
  return null; 
} 

export function inferDashboardAiSemanticIntent(input: {
  userPrompt: string;
  context?: DashboardAiContext | Record<string, unknown> | null;
}): DashboardAiSemanticIntent {
  const normalized = normalizePromptForToolRouting(input.userPrompt);
  const monthPair = inferDashboardAiSqlMonthPair(input.userPrompt, input.context);
  const month = inferSingleDashboardAiSqlMonth(input.userPrompt, input.context);
  const seasonCodes = Array.from(new Set(Array.from(input.userPrompt.matchAll(/\b[SW]\d{2}\b/gi)).map((match) => match[0].toUpperCase())));
  const wantsPax = /\b(pax|khach|khach)\b/.test(normalized);
  const wantsRoute = /\b(route|duong bay)\b/.test(normalized);
  const wantsAirline = /\b(vn|vietnam airlines|airline|hang bay)\b/.test(normalized);
  const wantsAircraft = /\b(aircraft|may bay|tau bay)\b/.test(normalized);
  const wantsCountry = /\b(country|quoc gia)\b/.test(normalized);
  const wantsPeakDay = /\b(ngay|daily|theo ngay|cao diem|bat thuong|anomaly)\b/.test(normalized) &&
    /\b(cao diem|nhieu nhat|cao nhat|peak|bat thuong|anomaly)\b/.test(normalized);
  const wantsFlightDetail = /\b(thong tin chuyen|chi tiet chuyen bay|flight detail|chuyen bay cu the)\b/.test(normalized);
  const dimensions = [
    ...(wantsRoute ? ['route'] : []),
    ...(wantsAirline ? ['airline'] : []),
    ...(wantsCountry ? ['country'] : []),
    ...(wantsAircraft ? ['aircraft'] : []),
    ...(wantsPeakDay ? ['ops_date'] : []),
  ];
  const workflowId: DashboardAiSemanticIntent['workflowId'] = wantsFlightDetail
    ? 'flight-detail-investigation'
    : seasonCodes.length >= 2
      ? 'season-to-season-frequency'
      : monthPair
        ? 'month-comparison-drivers'
        : wantsPeakDay
          ? 'peak-day-anomaly'
          : wantsRoute && wantsPax
            ? 'route-pax-ranking'
            : 'general-query';
  return {
    workflowId,
    metrics: wantsPax ? ['pax', 'flights'] : ['flights'],
    dimensions: dimensions.length > 0 ? Array.from(new Set(dimensions)) : ['airline'],
    dateScope: {
      ...(monthPair ? { months: [monthPair.current, monthPair.previous] } : month ? { months: [month] } : {}),
    },
    ...(monthPair ? { comparisonScope: { current: monthPair.current, previous: monthPair.previous } } : {}),
    entities: {
      ...(wantsAirline && /\b(vn|vietnam airlines)\b/i.test(input.userPrompt) ? { airlines: ['VN'] } : {}),
    },
    requiresBaseline: wantsPeakDay || /\b(baseline|so voi cac ngay con lai|bat thuong)\b/.test(normalized),
    requiresDrilldown: wantsPeakDay || /\b(driver|phan ra|drilldown|chi tiet)\b/.test(normalized),
  };
}

function skillById(id: DashboardAiSkillDefinition['id']): DashboardAiSkillDefinition {
  return DASHBOARD_AI_SKILL_REGISTRY.find((skill) => skill.id === id) ?? DASHBOARD_AI_SKILL_REGISTRY[0];
}

export function buildDashboardAiNotebookContext(
  cells: DashboardAiNotebookCell[],
  options: { maxCells?: number; maxTextChars?: number; activeCellId?: string | null; maxActiveRows?: number } = {}
): DashboardAiNotebookContext {
  const maxCells = Math.max(0, options.maxCells ?? 3);
  const maxTextChars = Math.max(40, options.maxTextChars ?? 320);
  const selected = cells.slice(-maxCells);
  const activeCell = resolveDashboardAiActiveCell(cells, options.activeCellId);
  const activeArtifact = activeCell
    ? activeCell.activeArtifact ?? buildDashboardAiActiveArtifactFromCell(activeCell, { sourceCellIndex: cells.findIndex((cell) => cell.id === activeCell.id) + 1 })
    : undefined;
  return {
    cells: selected.map((cell): DashboardAiNotebookContextCell => ({
      id: cell.id,
      prompt: sanitizeVisualText(cell.prompt, '', maxTextChars),
      assistantSummary: sanitizeVisualText(cell.assistantText, '', maxTextChars),
      blockSummaries: cell.blocks.slice(0, 8).map((block): DashboardAiNotebookBlockSummary => ({
        id: block.id,
        type: block.type,
        title: block.title,
        source: block.source,
        ...(block.table?.templateId ? { templateId: block.table.templateId } : {}),
        ...(block.chart?.chartType ? { chartType: block.chart.chartType } : {}),
        ...((block.table?.filters || block.chart?.filters) ? { filters: block.table?.filters ?? block.chart?.filters } : {}),
      })),
      toolTraceSummary: cell.toolTraceSummary.slice(0, 4),
      createdAt: cell.createdAt,
      ...(cell.modelId ? { modelId: cell.modelId } : {}),
    })),
    capped: cells.length > selected.length,
    ...(activeArtifact ? { activeArtifact } : {}),
    ...(activeCell?.queryResults?.length
      ? { activeQuerySample: capDashboardAiNotebookQueryResults(activeCell.queryResults, { maxResults: 2, maxRowsPerResult: options.maxActiveRows ?? 12 }) }
      : {}),
  };
}

function resolveDashboardAiActiveCell(cells: DashboardAiNotebookCell[], activeCellId?: string | null): DashboardAiNotebookCell | null {
  if (activeCellId) {
    const pinned = cells.find((cell) => cell.id === activeCellId);
    if (pinned) return pinned;
  }
  return [...cells].reverse().find((cell) =>
    Boolean(cell.activeArtifact) ||
    Boolean(cell.queryResults?.some((result) => result.rows.length > 0)) ||
    cell.blocks.some((block) => Boolean(block.table?.rows?.length || block.chart?.rows?.length))
  ) ?? null;
}

export function capDashboardAiNotebookQueryResults(
  queryResults: DashboardAiQueryResult[] | undefined,
  options: { maxResults?: number; maxRowsPerResult?: number } = {}
): DashboardAiQueryResult[] {
  const maxResults = Math.max(0, options.maxResults ?? 2);
  const maxRowsPerResult = Math.max(0, options.maxRowsPerResult ?? 100);
  return (queryResults ?? []).slice(0, maxResults).map((result) => {
    const rows = result.rows.slice(0, maxRowsPerResult).map((row) => {
      const normalized: Record<string, DashboardAiQueryCell> = {};
      for (const column of result.columns.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxColumns)) {
        normalized[column] = sanitizeWorkbookCell(row[column]);
      }
      return normalized;
    });
    return {
      ...result,
      columns: result.columns.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxColumns),
      rows,
      truncated: result.truncated || result.rows.length > rows.length,
      dataQualityNotes: result.dataQualityNotes.slice(0, DASHBOARD_VISUAL_REPORT_LIMITS.maxNotes),
    };
  });
}

export function buildDashboardAiActiveArtifactFromCell(
  cell: DashboardAiNotebookCell,
  options: { sourceCellIndex?: number; seasonIds?: string[] } = {}
): DashboardAiActiveArtifact {
  const queryResults = cell.queryResults ?? [];
  const queryIds = queryResults.map((result) => result.queryId).filter(Boolean);
  const blockIds = cell.blocks.map((block) => block.id).filter(Boolean).slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks);
  const allRows = queryResults.flatMap((result) => result.rows);
  const opsDates = allRows
    .map((row) => typeof row.ops_date === 'string' ? row.ops_date : typeof row.date === 'string' ? row.date : null)
    .filter((date): date is string => Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date)))
    .sort();
  const peakRow = [...allRows].sort((left, right) => Number(right.flights ?? 0) - Number(left.flights ?? 0))[0];
  const peakDate = typeof peakRow?.ops_date === 'string' ? peakRow.ops_date : opsDates.at(-1);
  const month = peakDate?.slice(0, 7) ?? opsDates[0]?.slice(0, 7);
  const airlines = uniqueDashboardAiEntityValues(allRows, 'airline');
  const routes = uniqueDashboardAiEntityValues(allRows, 'route');
  const hours = Array.from(new Set(allRows.map((row) => Number(row.local_hour)).filter((value) => Number.isFinite(value)))).slice(0, 12);
  const summaryVi = peakDate
    ? `Ngày cao điểm ${peakDate}`
    : cell.blocks[0]?.title
      ? cell.blocks[0].title
      : sanitizeVisualText(cell.assistantText || cell.prompt, 'Ngữ cảnh AI', 80);
  return {
    sourceCellId: cell.id,
    ...(options.sourceCellIndex ? { sourceCellIndex: options.sourceCellIndex } : {}),
    queryIds,
    ...(opsDates.length ? { dateRange: { from: opsDates[0], to: opsDates[opsDates.length - 1] } } : {}),
    ...(month ? { month } : {}),
    seasonIds: normalizeDashboardAiWorkspaceSeasonIds(options.seasonIds ?? []),
    entities: {
      ...(peakDate ? { peakDate } : {}),
      metric: 'flights',
      airlines,
      routes,
      hours,
    },
    blockIds,
    summaryVi,
  };
}

function uniqueDashboardAiEntityValues(rows: Record<string, DashboardAiQueryCell>[], key: string): string[] {
  return Array.from(new Set(rows.map((row) => String(row[key] ?? '').trim()).filter(Boolean))).slice(0, 12);
}

export function resolveDashboardAgentToolForPrompt(
  prompt: string,
  allowedTools: DashboardAiToolName[] = DASHBOARD_AI_TOOL_REGISTRY.map((tool) => tool.name)
): DashboardAiToolName {
  const allowed = new Set(allowedTools);
  const normalized = normalizePromptForToolRouting(prompt);
  const canUse = (tool: DashboardAiToolName) => allowed.has(tool);
  if (canUse('compose_dashboard_ai_board') && /\b(ai workspace|workspace|whiteboard|board|canvas|bang trang|block board|multi-season|three seasons|3 seasons|so sanh 3 mua)\b/.test(normalized)) {
    return 'compose_dashboard_ai_board';
  }
  if (canUse('suggest_custom_workbook') && /\b(custom|rieng|riÃªng|tuá»³ chá»‰nh|tuy chinh|workbook|workbook rieng|custom workbook)\b/.test(normalized)) {
    return 'suggest_custom_workbook';
  }
  if (canUse('suggest_visual_report') && /\b(visual|visual report|chart|graph|plot|ve|váº½|bieu do|biá»ƒu Ä‘á»“|dashboard visual|peak hour)\b/.test(normalized)) {
    return 'suggest_visual_report';
  }
  if (canUse('suggest_custom_workbook') && /\b(export|download|excel|xlsx|report|bao cao|bÃ¡o cÃ¡o|san luong|sáº£n lÆ°á»£ng|sanluong)\b/.test(normalized)) {
    return 'suggest_custom_workbook';
  }
  if (canUse('query_dashboard_data')) {
    return 'query_dashboard_data';
  }
  return allowedTools[0] ?? 'query_dashboard_data';
}

export function resolveDashboardAiWorkspaceToolForPrompt(
  prompt: string,
  allowedTools: DashboardAiToolName[] = DASHBOARD_AI_TOOL_REGISTRY.map((tool) => tool.name)
): DashboardAiToolName {
  const allowed = new Set(allowedTools);
  if (allowed.has('compose_dashboard_ai_board') && isDashboardAiWorkspaceBoardIntent(prompt)) {
    return 'compose_dashboard_ai_board';
  }
  return resolveDashboardAgentToolForPrompt(prompt, allowedTools);
}

export function listEnabledDashboardAiModels(settings?: AiAnalysisSettings | null): AiAnalysisModelSetting[] {
  const source = settings ?? DEFAULT_AI_ANALYSIS_SETTINGS;
  if (source.enabled === false) return [];
  return source.models.filter((model) => model.enabled);
}

export function resolveDashboardAiModel(
  settings?: AiAnalysisSettings | null,
  preferredModelId?: string | null
): AiAnalysisModelSetting | null {
  const enabledModels = listEnabledDashboardAiModels(settings);
  if (enabledModels.length === 0) return null;
  const source = settings ?? DEFAULT_AI_ANALYSIS_SETTINGS;
  return enabledModels.find((model) => model.id === preferredModelId) ??
    enabledModels.find((model) => model.id === source.activeModelId) ??
    enabledModels[0] ??
    null;
}

export function isDashboardAiConfigured(settings?: AiAnalysisSettings | null): boolean {
  return resolveDashboardAiModel(settings) != null;
}

export function buildDashboardAiContext(input: BuildDashboardAiContextInput): DashboardAiContext {
  const selectedDriverRecords = input.selectedDriverRecords ?? [];
  const activeRecords = selectedDriverRecords
    .filter((record) => record.status !== 'deleted')
    .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule));
  const seasonRecords = (input.seasonRecords ?? selectedDriverRecords)
    .filter((record) => record.status !== 'deleted')
    .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule));
  const maxSelectedRecords = input.maxSelectedRecords ?? DEFAULT_MAX_SELECTED_RECORDS;
  const includedRecords = activeRecords.slice(0, Math.max(0, maxSelectedRecords)).map(toAiSelectedRecord);

  const context: DashboardAiContext = {
    contextVersion: 2,
    generatedAt: (input.now ?? new Date()).toISOString(),
    seasonCatalog: buildSeasonCatalog({
      records: seasonRecords,
      routeCountries: input.routeCountries ?? undefined,
      maxRows: input.maxCatalogRows ?? DEFAULT_MAX_CATALOG_ROWS,
    }),
    resolvedDataRequest: input.resolvedDataRequest ?? null,
  };
  if (input.filters) context.filters = input.filters;
  if (input.comparison && input.filters) context.comparison = input.comparison ?? buildEmptyComparison(input.filters);
  if (input.semanticIntent) context.semanticIntent = input.semanticIntent;
  if (input.waterfallRows) context.waterfallRows = input.waterfallRows;
  if (input.selectedDriver !== undefined) context.selectedDriver = input.selectedDriver;
  if (input.selectedDriverRecords) {
    context.selectedDriverRecords = {
      totalRecords: activeRecords.length,
      includedRecords: includedRecords.length,
      truncated: activeRecords.length > includedRecords.length,
      records: includedRecords,
    };
  }
  return context;
}

export function buildDashboardAiPrompt(input: {
  userPrompt: string;
  context: DashboardAiContext;
  availableTools?: DashboardAiToolDefinition[];
  selectedSkillId?: DashboardAiSkillDefinition['id'] | null;
  contextProfile?: DashboardAiContextProfile | null;
  workflowId?: DashboardAiWorkflowId | DashboardAiSemanticIntent['workflowId'] | string | null;
  preparedDataContracts?: DashboardAiPreparedDataContract[];
  notebookContext?: DashboardAiNotebookContext | null;
  language?: DashboardAiLanguage;
}): string {
  const language = input.language ?? 'vi';
  const availableTools = input.availableTools ?? resolveDashboardAiAvailableTools({
    aiConfigured: true,
    operatorAuthorized: true,
    hasSelectedSeason: true,
    hasLocalRecords: true,
    selectedSeasonCount: 1,
    exportEnabled: true,
  });
  const selectedSkill = input.selectedSkillId ? DASHBOARD_AI_SKILL_REGISTRY.find((skill) => skill.id === input.selectedSkillId) ?? null : null;
  const contextWithCustomDocuments = input.context as unknown as Record<string, unknown>;
  const customContextDocuments = Array.isArray(contextWithCustomDocuments.aiContextDocuments)
    ? (contextWithCustomDocuments.aiContextDocuments as Array<{ kind?: string; title?: string; contentMd?: string; enabled?: boolean }>)
    : [];
  const customRulesMd = customContextDocuments
    .filter((document) => document.enabled !== false && document.kind === 'rule' && document.contentMd?.trim())
    .map((document) => `### ${document.title ?? 'Rule'}\n${String(document.contentMd).trim()}`)
    .join('\n\n') || 'none';
  const customSkillsMd = customContextDocuments
    .filter((document) => document.enabled !== false && document.kind === 'skill' && document.contentMd?.trim())
    .map((document) => `### ${document.title ?? 'Skill'}\n${String(document.contentMd).trim()}`)
    .join('\n\n') || 'none';
  return [
    'STABLE_AGENT_CONTRACT:',
    JSON.stringify({
      language,
      languagePolicy: 'LuÃ´n tráº£ lá»i báº±ng tiáº¿ng Viá»‡t. Giá»¯ nguyÃªn ARR/DEP, KPI, airline code, route code vÃ  internal tool/schema ids.',
      grounding: DASHBOARD_AI_GROUNDING_INSTRUCTIONS,
      tools: availableTools.map((tool) => ({
        name: tool.name,
        toolset: tool.toolset,
        availability: tool.availability ?? 'enabled',
        disabledReason: tool.disabledReason ?? null,
        description: tool.description,
        outputContract: tool.outputContract,
      })),
      skills: DASHBOARD_AI_SKILL_REGISTRY.map((skill) => ({
        id: skill.id,
        descriptionVi: skill.descriptionVi,
        triggersVi: skill.triggersVi,
        preferredTool: skill.preferredTool,
        contextProfile: skill.contextProfile,
      })),
      blockWhitelist: {
        blockTypes: DASHBOARD_AI_WORKSPACE_BLOCK_TYPES,
        chartTypes: DASHBOARD_AI_WORKSPACE_CHART_TYPES,
        tableTemplates: DASHBOARD_AI_WORKSPACE_TABLE_TEMPLATE_IDS,
      },
      dataQueryContract: { 
        tool: 'query_dashboard_data', 
        views: ['flight_operations', 'summary_airline', 'summary_country', 'summary_route', 'summary_month', 'summary_week', 'summary_peak_hour', 'summary_aircraft', 'summary_arr_dep_mix'],
        filters: ['seasonIds', 'iataSeasonCodes', 'dateFrom', 'dateTo', 'months', 'weeks', 'typeFilter', 'airlines', 'routes', 'countries', 'aircraft', 'localHourFrom', 'localHourTo'],
        metrics: ['flights', 'pax', 'arrivals', 'departures'],
        output: 'Khi cáº§n dá»¯ liá»‡u chi tiáº¿t, tráº£ dataQueries; Edge Function sáº½ query Supabase reporting views vÃ  tráº£ queryResults. KhÃ´ng tá»± viáº¿t SQL.', 
      }, 
      verificationContract: {
        profile: 'Sau khi query, app sẽ lập DashboardAiResultProfile gồm coverage, null/distinct, metric stats, top values và outlier candidates.',
        answer: 'Chỉ nêu số liệu có trong query result/profile; nếu thiếu bằng chứng, trả data-quality note thay vì suy đoán.',
      },
      richResponseContract: { 
        markdownBlock: 'CÃ³ thá»ƒ tráº£ block type rich-markdown vá»›i markdown tiáº¿ng Viá»‡t Ä‘Ã£ gá»n.', 
        htmlPreviewBlock: 'HTML chỉ được trả qua block type html-preview/htmlPreview để app render trong iframe sandbox. Chỉ HTML/CSS tĩnh; không yêu cầu script, Python, form, iframe con, object/embed hoặc external script.', 
      }, 
      safety: 'Read-only. Có thể sinh sqlQueryPlans SELECT/CTE cho SQLite local qua gateway validate; không sinh đường dẫn file hoặc thao tác ghi dữ liệu. Không chạy raw HTML/script/Python trong DOM chính; HTML chỉ là sandbox preview tĩnh đã sanitize.', 
    }, null, 2),
    '',
    'LANGUAGE_POLICY:',
    'language: vi',
    'LuÃ´n tráº£ lá»i báº±ng tiáº¿ng Viá»‡t á»Ÿ assistantText, tiÃªu Ä‘á» block, insights, dataQualityNotes, lÃ½ do tool trace vÃ  fallback narrative.',
    '',
    'CUSTOM_RULES_MD:',
    customRulesMd.slice(0, 12 * 1024),
    '',
    'CUSTOM_SKILLS_MD:',
    customSkillsMd.slice(0, 12 * 1024),
    '',
    `USER_PROMPT: ${input.userPrompt.trim()}`,
    '',
    'EPHEMERAL_DASHBOARD_CONTEXT:',
    JSON.stringify({
      selectedSkillId: selectedSkill?.id ?? input.selectedSkillId ?? null,
      selectedSkill,
      contextProfile: input.contextProfile ?? selectedSkill?.contextProfile ?? null,
      notebookContext: input.notebookContext ?? null,
    }, null, 2),
    '',
    'DASHBOARD_CONTEXT_JSON:',
    JSON.stringify(input.context, null, 2),
  ].join('\n');
}

export function buildDashboardAiFunctionRequest(input: {
  userPrompt: string;
  context: DashboardAiContext;
  history?: DashboardAiChatMessage[];
  model: AiAnalysisModelSetting | null | undefined;
  preferredTool?: DashboardAiToolName | null;
  allowDataRequest?: boolean;
  availableTools?: DashboardAiToolDefinition[];
  selectedSkillId?: DashboardAiSkillDefinition['id'] | null;
  contextProfile?: DashboardAiContextProfile | null;
  workflowId?: DashboardAiWorkflowId | DashboardAiSemanticIntent['workflowId'] | string | null;
  preparedDataContracts?: DashboardAiPreparedDataContract[];
  notebookContext?: DashboardAiNotebookContext | null;
  language?: DashboardAiLanguage;
  providerFallback?: boolean;
  signal?: AbortSignal;
}): DashboardAiFunctionRequest {
  if (!input.model?.id) {
    throw new DashboardAiConfigurationError('AI analysis model is not configured. Configure AI Analysis models in Settings.');
  }
  const availableTools = input.availableTools ?? resolveDashboardAiAvailableTools({
    aiConfigured: true,
    operatorAuthorized: true,
    hasSelectedSeason: true,
    hasLocalRecords: true,
    selectedSeasonCount: 1,
    exportEnabled: true,
  });
  const enabledToolNames = availableTools
    .filter((tool) => tool.availability !== 'disabled')
    .map((tool) => tool.name);
  return {
    userPrompt: input.userPrompt.trim(),
    context: input.context,
    history: (input.history ?? []).slice(-6),
    modelId: input.model.id,
    allowedExportActions: DASHBOARD_AI_EXPORT_ACTION_FILENAMES,
    allowedTools: enabledToolNames.length > 0 ? enabledToolNames : DASHBOARD_AI_TOOL_REGISTRY.map((tool) => tool.name),
    availableTools,
    ...(input.preferredTool ? { preferredTool: input.preferredTool } : {}),
    ...(input.selectedSkillId ? { selectedSkillId: input.selectedSkillId } : {}),
    ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.preparedDataContracts ? { preparedDataContracts: input.preparedDataContracts } : {}),
    ...(input.notebookContext ? { notebookContext: input.notebookContext } : {}),
    language: input.language ?? 'vi',
    providerFallback: input.providerFallback === true,
    allowedReportTemplates: DASHBOARD_AI_REPORT_TEMPLATE_IDS,
    allowedVisualReports: DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS,
    maxRounds: DASHBOARD_AI_MAX_ROUNDS,
    allowDataRequest: input.allowDataRequest !== false,
    allowCustomWorkbook: true,
  };
}

export async function analyzeDashboardWithAi(request: DashboardAiRequest): Promise<DashboardAiAnalysisResponse> {
  if (request.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const body = buildDashboardAiFunctionRequest({
    userPrompt: request.userPrompt,
    context: request.context,
    history: request.history,
    model: request.model,
    preferredTool: request.preferredTool,
    allowDataRequest: request.allowDataRequest,
    availableTools: request.availableTools,
    selectedSkillId: request.selectedSkillId,
    contextProfile: request.contextProfile,
    workflowId: request.workflowId,
    preparedDataContracts: request.preparedDataContracts,
    notebookContext: request.notebookContext,
    language: request.language ?? 'vi',
    providerFallback: request.providerFallback,
  });
  const supabase = request.supabaseClient ?? getSupabaseClient();
  let providerAttempt = 1;
  let invokeResult = await supabase.functions.invoke('dashboard-ai-analysis', { body });
  if (request.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (invokeResult.error && request.providerFallback === true) {
    const message = await readFunctionInvokeError(invokeResult.error);
    if (isTransientDashboardAiProviderError(message)) {
      providerAttempt = 2;
      invokeResult = await supabase.functions.invoke('dashboard-ai-analysis', {
        body: {
          ...body,
          providerFallback: true,
        },
      });
      if (request.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (invokeResult.error) throw new DashboardAiRequestError(await readFunctionInvokeError(invokeResult.error));
    } else {
      throw new DashboardAiRequestError(message);
    }
  } else if (invokeResult.error) {
    throw new DashboardAiRequestError(await readFunctionInvokeError(invokeResult.error));
  }
  const { data } = invokeResult;
  const remoteResponse = readAssistantResponse(data);
  const localQueryResults = request.localQueryResults ?? [];
  const response: DashboardAiAnalysisResponse = localQueryResults.length > 0
    ? {
        ...remoteResponse,
        queryResults: mergeDashboardAiQueryResults(localQueryResults, remoteResponse.queryResults),
        preparedDataContracts: remoteResponse.preparedDataContracts ?? buildDashboardAiPreparedDataContracts(
          localQueryResults,
          typeof request.workflowId === 'string'
            ? DASHBOARD_AI_WORKFLOW_REGISTRY.find((workflow) => workflow.id === request.workflowId) ?? null
            : null
        ),
      }
    : remoteResponse;
  const queryBoardPatch = buildDashboardAiBoardPatchFromQueryResults(response.queryResults, request.userPrompt);
  const preferQueryResults = shouldPreferDashboardAiQueryResults({
    userPrompt: request.userPrompt,
    queryResults: response.queryResults,
    boardPatch: response.boardPatch,
  });
  const retryTrace: DashboardAiToolTraceSummary | null = providerAttempt > 1
    ? {
        tool: request.preferredTool ?? 'query_dashboard_data',
        status: 'executed',
        reason: 'Thá»­ láº¡i provider má»™t láº§n sau lá»—i táº¡m thá»i.',
        ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
        ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
        providerAttempt,
      }
    : null;
  const staleBoardTrace: DashboardAiToolTraceSummary | null = preferQueryResults && response.boardPatch && queryBoardPatch
    ? {
        tool: 'compose_dashboard_ai_board',
        status: 'rejected',
        reason: 'Bá» qua boardPatch cá»§a provider vÃ¬ prompt yÃªu cáº§u truy váº¥n dá»¯ liá»‡u vÃ  block khÃ´ng gáº¯n sourceQueryId phÃ¹ há»£p.',
        toolset: 'dashboard-visual',
        fallbackReason: 'Æ¯u tiÃªn queryResults cho query-first notebook.',
        ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
        ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
      }
    : null;
  const localQueryTrace: DashboardAiToolTraceSummary | null = localQueryResults.length > 0
    ? {
        tool: 'query_dashboard_data',
        status: 'executed',
        reason: localQueryResults.some((result) => result.dataQualityNotes.some((note) => note.includes('chưa đồng bộ')))
          ? 'Nguồn: SQLite local, bao gồm thay đổi chưa đồng bộ.'
          : 'Nguồn: SQLite local từ dữ liệu dashboard đang hiển thị.',
        toolset: 'dashboard-readonly',
        ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
        ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
      }
    : null;
  const selectedBoardPatch = preferQueryResults
    ? queryBoardPatch ?? response.boardPatch
    : response.boardPatch ?? queryBoardPatch;
  const fallbackBoardPatch = selectedBoardPatch
    ? null
    : buildDashboardAiFallbackBoardPatch({
        userPrompt: request.userPrompt,
        preferredTool: request.preferredTool,
        visualReport: response.visualReport,
      });
  if (selectedBoardPatch && selectedBoardPatch !== response.boardPatch) { 
    return applyDashboardAiResultProfileAndVerification({ 
      ...response, 
      boardPatch: selectedBoardPatch, 
      toolTraceSummary: [ 
        ...(localQueryTrace ? [localQueryTrace] : []),
        ...response.toolTraceSummary,
        ...(retryTrace ? [retryTrace] : []),
        ...(staleBoardTrace ? [staleBoardTrace] : []), 
      ].slice(0, 8), 
    }, request); 
  } 
  if (!fallbackBoardPatch) { 
    const responseWithoutFallback = retryTrace 
      ? { ...response, toolTraceSummary: [...(localQueryTrace ? [localQueryTrace] : []), ...response.toolTraceSummary, retryTrace].slice(0, 8) } 
      : localQueryTrace 
        ? { ...response, toolTraceSummary: [localQueryTrace, ...response.toolTraceSummary].slice(0, 8) } 
        : response; 
    return applyDashboardAiResultProfileAndVerification(responseWithoutFallback, request); 
  } 
  const hasBoardTrace = response.toolTraceSummary.some((trace) => trace.tool === 'compose_dashboard_ai_board');
  const fallbackTrace: DashboardAiToolTraceSummary = {
    tool: 'compose_dashboard_ai_board',
    status: 'accepted',
    reason: 'ÄÃ£ táº¡o block notebook fallback tá»« intent báº£ng/biá»ƒu Ä‘á»“.',
    ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
    toolset: 'dashboard-visual',
    fallbackReason: 'Provider khÃ´ng tráº£ boardPatch há»£p lá»‡.',
    ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
  };
  return applyDashboardAiResultProfileAndVerification({ 
    ...response, 
    boardPatch: fallbackBoardPatch, 
    toolTraceSummary: hasBoardTrace
      ? (retryTrace || localQueryTrace ? [...(localQueryTrace ? [localQueryTrace] : []), ...response.toolTraceSummary, ...(retryTrace ? [retryTrace] : [])].slice(0, 8) : response.toolTraceSummary)
      : [
          ...(localQueryTrace ? [localQueryTrace] : []),
          ...response.toolTraceSummary,
          ...(retryTrace ? [retryTrace] : []),
          fallbackTrace, 
        ].slice(0, 8), 
  }, request); 
} 

function mergeDashboardAiQueryResults( 
  localResults: DashboardAiQueryResult[],
  remoteResults: DashboardAiQueryResult[]
): DashboardAiQueryResult[] {
  const merged = new Map<string, DashboardAiQueryResult>();
  for (const result of remoteResults) merged.set(result.queryId, result);
  for (const result of localResults) merged.set(result.queryId, result);
  return Array.from(merged.values()).slice(0, DASHBOARD_AI_MAX_ROUNDS); 
} 

export function applyDashboardAiResultProfileAndVerification(
  response: DashboardAiAnalysisResponse,
  request: Pick<DashboardAiRequest, 'userPrompt' | 'selectedSkillId' | 'contextProfile'>
): DashboardAiAnalysisResponse {
  if (response.queryResults.length === 0) return response;
  const resultProfiles = profileDashboardAiQueryResults(response.queryResults);
  const answerVerification = verifyDashboardAiAnswerAgainstQueryResults({
    assistantText: response.assistantText,
    queryResults: response.queryResults,
    profiles: resultProfiles,
  });
  const profileTrace: DashboardAiToolTraceSummary = {
    tool: 'query_dashboard_data',
    status: 'executed',
    reason: `profiled_query_result: Đã lập hồ sơ ${resultProfiles.length} kết quả truy vấn gồm coverage, null/distinct, thống kê metric và outlier candidates.`,
    phase: 'profiled_query_result',
    toolset: 'dashboard-readonly',
    ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
    ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
  };
  const verificationTrace: DashboardAiToolTraceSummary = {
    tool: 'query_dashboard_data',
    status: answerVerification.status === 'passed' ? 'executed' : 'rejected',
    reason: `verified_answer: ${answerVerification.reasonVi}`,
    phase: 'verified_answer',
    toolset: 'dashboard-readonly',
    ...(request.selectedSkillId ? { skill: request.selectedSkillId } : {}),
    ...(request.contextProfile ? { contextProfile: request.contextProfile } : {}),
    ...(answerVerification.status === 'warning' ? { fallbackReason: 'Câu trả lời có số liệu không khớp query result/profile.' } : {}),
  };
  const assistantText = answerVerification.status === 'warning' && !response.assistantText.includes('Lưu ý kiểm chứng:')
    ? `${response.assistantText}\n\nLưu ý kiểm chứng: ${answerVerification.reasonVi}`
    : response.assistantText;
  const boardPatch = answerVerification.status === 'warning'
    ? appendDashboardAiVerificationNote(response.boardPatch, answerVerification)
    : response.boardPatch;
  const traceKeys = new Set(response.toolTraceSummary.map((trace) => trace.phase));
  const nextTrace = [
    ...(traceKeys.has('profiled_query_result') ? [] : [profileTrace]),
    ...(traceKeys.has('verified_answer') ? [] : [verificationTrace]),
    ...response.toolTraceSummary,
  ].slice(0, 8);
  return {
    ...response,
    assistantText,
    boardPatch,
    resultProfiles,
    answerVerification,
    toolTraceSummary: nextTrace,
  };
}

export async function analyzeDashboardWithLocalAgent(request: DashboardAiLocalAgentRequest): Promise<DashboardAiAnalysisResponse | null> {
  if (request.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const rawResponse = await request.localAgentClient({
    model: {
      provider: request.model.provider,
      model: request.model.model,
      baseUrl: request.model.baseUrl,
    },
    seasonIds: request.seasonIds,
    prompt: request.userPrompt,
    workflowId: request.workflowId ?? null,
    semanticIntent: request.semanticIntent ?? null,
    requiredGates: request.requiredGates ?? [],
    sessionArtifact: request.sessionArtifact ?? null,
    notebookContext: request.notebookContext ?? null,
    contextDocuments: request.contextDocuments ?? [],
    sourcePolicy: 'local-sqlite',
    language: 'vi',
  });
  if (request.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (rawResponse == null) return null;
  const response = readAssistantResponse(normalizeLocalAgentResponse(rawResponse));
  if (response.preparedDataContracts?.length || response.queryResults.length === 0) return response;
  const workflow = typeof response.workflowId === 'string'
    ? DASHBOARD_AI_WORKFLOW_REGISTRY.find((item) => item.id === response.workflowId) ?? null
    : typeof request.workflowId === 'string'
      ? DASHBOARD_AI_WORKFLOW_REGISTRY.find((item) => item.id === request.workflowId) ?? null
      : null;
  return {
    ...response,
    workflowId: response.workflowId ?? request.workflowId ?? null,
    preparedDataContracts: buildDashboardAiPreparedDataContracts(response.queryResults, workflow),
  };
}

function normalizeLocalAgentResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  return {
    ...raw,
    assistantText: raw.assistantText ?? raw.assistant_text,
    queryResults: raw.queryResults ?? raw.query_results,
    resultProfiles: raw.resultProfiles ?? raw.result_profiles,
    answerVerification: raw.answerVerification ?? raw.answer_verification,
    boardPatch: raw.boardPatch ?? raw.board_patch,
    toolTraceSummary: raw.toolTraceSummary ?? raw.tool_trace_summary,
    workflowId: raw.workflowId ?? raw.workflow_id,
    preparedDataContracts: raw.preparedDataContracts ?? raw.prepared_data_contracts,
    workflowTraceSummary: raw.workflowTraceSummary ?? raw.workflow_trace_summary,
    exportAction: raw.exportAction ?? raw.export_action,
  };
}

export function profileDashboardAiQueryResults(queryResults: DashboardAiQueryResult[]): DashboardAiResultProfile[] {
  return queryResults.map((result) => profileDashboardAiQueryResult(result));
}

function profileDashboardAiQueryResult(result: DashboardAiQueryResult): DashboardAiResultProfile {
  const rows = result.rows ?? [];
  const nullCounts: Record<string, number> = {};
  const distinctValues: Record<string, Set<string>> = {};
  const numericValues: Record<string, number[]> = {};
  const topValueCounts: Record<string, Map<string, number>> = {};
  for (const column of result.columns) {
    nullCounts[column] = 0;
    distinctValues[column] = new Set<string>();
    numericValues[column] = [];
    topValueCounts[column] = new Map<string, number>();
  }
  for (const row of rows) {
    for (const column of result.columns) {
      const value = row[column];
      const isEmpty = value == null || value === '';
      if (isEmpty) {
        nullCounts[column] = (nullCounts[column] ?? 0) + 1;
        continue;
      }
      const stringValue = String(value);
      distinctValues[column]?.add(stringValue);
      topValueCounts[column]?.set(stringValue, (topValueCounts[column]?.get(stringValue) ?? 0) + 1);
      const numericValue = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(numericValue) && stringValue.trim() !== '') {
        numericValues[column]?.push(numericValue);
      }
    }
  }
  const distinctCounts = Object.fromEntries(Object.entries(distinctValues).map(([column, values]) => [column, values.size]));
  const metricStats: DashboardAiResultProfile['metricStats'] = {};
  for (const [column, values] of Object.entries(numericValues)) {
    if (values.length === 0) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    metricStats[column] = {
      min: Math.min(...values),
      max: Math.max(...values),
      average: sum / values.length,
      sum,
    };
  }
  const topValues: DashboardAiResultProfile['topValues'] = {};
  for (const [column, counts] of Object.entries(topValueCounts)) {
    if ((numericValues[column]?.length ?? 0) === rows.length) continue;
    topValues[column] = Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));
  }
  const dateCoverage = inferDashboardAiResultDateCoverage(result);
  const labelColumn = result.columns.find((column) => !metricStats[column]) ?? result.columns[0] ?? 'row';
  const outlierCandidates = Object.entries(metricStats).flatMap(([column, stats]) => {
    if (stats.max <= stats.average * 1.5 || stats.max <= 0) return [];
    const row = rows.find((entry) => Number(entry[column] ?? NaN) === stats.max);
    const label = String(row?.[labelColumn] ?? row?.ops_date ?? row?.month ?? row?.route ?? row?.airline ?? 'row');
    return [{
      column,
      label,
      value: stats.max,
      reasonVi: `${label} có ${column} cao hơn trung bình ${stats.average.toFixed(1)}.`,
    }];
  }).slice(0, 6);
  const dataQualityNotes = [
    ...(result.truncated ? [`Kết quả ${result.queryId} đã bị giới hạn/cắt bớt.`] : []),
    ...result.dataQualityNotes,
  ].slice(0, 8);
  return {
    queryId: result.queryId,
    rowCount: result.rowCount,
    truncated: result.truncated,
    columns: result.columns,
    ...(dateCoverage ? { dateCoverage } : {}),
    nullCounts,
    distinctCounts,
    metricStats,
    topValues,
    outlierCandidates,
    dataQualityNotes,
  };
}

function inferDashboardAiResultDateCoverage(result: DashboardAiQueryResult): DashboardAiResultProfile['dateCoverage'] | undefined {
  const field = ['ops_date', 'date', 'month', 'iso_week'].find((candidate) => result.columns.includes(candidate));
  if (!field) return undefined;
  const values = result.rows
    .map((row) => row[field])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .sort();
  if (values.length === 0) return undefined;
  return { from: values[0], to: values[values.length - 1], field };
}

export function verifyDashboardAiAnswerAgainstQueryResults(input: {
  assistantText: string;
  queryResults: DashboardAiQueryResult[];
  profiles?: DashboardAiResultProfile[];
}): DashboardAiAnswerVerification { 
  const acceptedNumbers = new Set<string>(); 
  const acceptedNumericValues: number[] = []; 
  const addAcceptedNumber = (value: number) => { 
    if (!Number.isFinite(value)) return; 
    acceptedNumbers.add(normalizeVerificationNumber(value)); 
    acceptedNumericValues.push(value); 
  }; 
  for (const result of input.queryResults) { 
    acceptedNumbers.add(String(result.rowCount)); 
    acceptedNumericValues.push(result.rowCount); 
    for (const row of result.rows) { 
      for (const value of Object.values(row)) { 
        const numericValue = typeof value === 'number' ? value : Number(value); 
        if (!Number.isFinite(numericValue)) continue; 
        addAcceptedNumber(numericValue); 
        addAcceptedNumber(Math.round(numericValue)); 
      } 
    } 
  } 
  for (const profile of input.profiles ?? []) { 
    for (const stats of Object.values(profile.metricStats)) { 
      addAcceptedNumber(stats.min); 
      addAcceptedNumber(stats.max); 
      addAcceptedNumber(stats.sum); 
      addAcceptedNumber(stats.average); 
      if (stats.average > 0) { 
        addAcceptedNumber(((stats.max - stats.average) / stats.average) * 100); 
        addAcceptedNumber(((stats.average - stats.min) / stats.average) * 100); 
        addAcceptedNumber((stats.max / stats.average) * 100); 
        addAcceptedNumber((stats.min / stats.average) * 100); 
      } 
    } 
  } 
  const unsupportedNumbers = Array.from(input.assistantText.matchAll(/(?<![\w-])[-+]?\d+(?:[.,]\d+)?(?![\w-])/g))
    .map((match) => match[0])
    .map((raw) => raw.replace(',', '.'))
    .filter((raw) => {
      const value = Number(raw);
      if (!Number.isFinite(value)) return false;
      if (Math.abs(value) < 10) return false;
      if (value >= 1900 && value <= 2100) return false;
      return !acceptedNumbers.has(normalizeVerificationNumber(value)) && 
        !acceptedNumericValues.some((accepted) => isApproximatelySameVerificationNumber(value, accepted)); 
    }) 
    .slice(0, 8);
  if (unsupportedNumbers.length > 0) {
    return {
      status: 'warning',
      reasonVi: `Một số số liệu trong câu trả lời chưa khớp query result/profile: ${unsupportedNumbers.join(', ')}.`,
      unsupportedNumbers,
      queryIds: input.queryResults.map((result) => result.queryId),
    };
  }
  return {
    status: 'passed',
    reasonVi: 'Các số liệu chính trong câu trả lời khớp query result/profile.',
    unsupportedNumbers: [],
    queryIds: input.queryResults.map((result) => result.queryId),
  };
}

function normalizeVerificationNumber(value: number): string { 
  if (!Number.isFinite(value)) return ''; 
  return Number.isInteger(value) ? String(value) : value.toFixed(1); 
} 

function isApproximatelySameVerificationNumber(value: number, accepted: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(accepted)) return false;
  const tolerance = Math.abs(value) >= 100 ? 0.6 : 0.15;
  return Math.abs(value - accepted) <= tolerance;
}

function appendDashboardAiVerificationNote(
  boardPatch: DashboardAiBoardPatch | null,
  verification: DashboardAiAnswerVerification
): DashboardAiBoardPatch | null {
  if (!boardPatch) return boardPatch;
  if (boardPatch.blocks.some((block) => block.id === 'answer-verification-warning')) return boardPatch;
  const verificationBlock: DashboardAiWorkspaceBlock = {
    id: 'answer-verification-warning',
    type: 'data-quality-notes',
    title: 'Kiểm chứng câu trả lời',
    source: 'resolvedDataRequest',
    insights: [verification.reasonVi],
  };
  return {
    ...boardPatch,
    blocks: [
      ...boardPatch.blocks,
      verificationBlock,
    ].slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks),
  };
}

function isTransientDashboardAiProviderError(message: string): boolean {
  return /\b(408|429|500|502|503|504|timeout|timed out|temporarily|service unavailable|rate limit)\b/i.test(message);
}

export function isDashboardAiDataRequestPrompt(text: string): boolean {
  const normalized = normalizePromptForToolRouting(text);
  const asksForMoreData = /\b(can du lieu|can truy xuat|truy xuat du lieu|yeu cau truy xuat|payload|payload hien tai|broader data|need broader|need more data|needs data|data request|request data|fetch data|retrieve data)\b/.test(normalized);
  const needsBreakdown = /\b(phan ra|phan tach|chi tiet|waterfall|driver|drivers|hang bay|duong bay|route|airline|bang phan ra|bang so sanh)\b/.test(normalized);
  return asksForMoreData || (needsBreakdown && /\b(chua co|khong co|missing|not present|not available|insufficient)\b/.test(normalized));
}

export function inferDashboardAiDataRequestFromText(input: {
  userPrompt: string;
  assistantText?: string | null;
  context: DashboardAiContext;
}): DashboardAiDataRequest | null {
  const combined = `${input.userPrompt}\n${input.assistantText ?? ''}`;
  const normalized = normalizePromptForToolRouting(combined);
  const months = inferPromptMonthPair(combined, input.context);
  if (!months) return null;
  const hasComparisonMonths = months.length >= 2 && /\b(so sanh|compare|comparison|vs|voi|with|driver|drivers|khac biet|diem khac biet|bien dong)\b/.test(normalized);
  if (!isDifferenceComparisonPrompt(normalized) && !isDashboardAiDataRequestPrompt(combined) && !hasComparisonMonths) return null;
  return {
    type: 'dashboard-data-request',
    scope: 'records',
    months,
    typeFilter: inferPromptTypeFilter(normalized),
    metric: 'flights',
    dimension: 'airline',
    maxRecords: DEFAULT_MAX_DATA_REQUEST_RECORDS,
  };
}

export function buildDashboardAiResolvedDataFallbackAnswer(input: {
  userPrompt: string;
  resolvedDataRequest: DashboardAiResolvedDataRequest;
}): DashboardAiAnalysisResponse {
  const comparison = input.resolvedDataRequest.comparison;
  const assistantText = comparison
    ? [
        `ÄÃ£ tá»± truy xuáº¥t dá»¯ liá»‡u local cho ${comparison.periodLabels.current} so vá»›i ${comparison.periodLabels.previous}.`,
        `Tá»•ng chuyáº¿n bay: ${comparison.current.flights.toLocaleString('en-US')} vs ${comparison.previous.flights.toLocaleString('en-US')}, thay Ä‘á»•i ${formatSignedNumber(comparison.delta)} (${formatNullablePercent(comparison.deltaPct)}).`,
        `ARR/DEP hiá»‡n táº¡i: ${comparison.current.arrivals.toLocaleString('en-US')}/${comparison.current.departures.toLocaleString('en-US')}; ká»³ trÆ°á»›c: ${comparison.previous.arrivals.toLocaleString('en-US')}/${comparison.previous.departures.toLocaleString('en-US')}.`,
      ].join('\n')
    : 'ÄÃ£ tá»± truy xuáº¥t dá»¯ liá»‡u dashboard local vÃ  táº¡o báº£ng/biá»ƒu Ä‘á»“ fallback tá»« dá»¯ liá»‡u Ä‘Ã£ resolve.';
  return {
    assistantText,
    dataRequest: null,
    exportAction: null,
    queryResults: [],
    sqlQueryPlans: [],
    visualReport: null,
    boardPatch: buildDashboardAiResolvedDataBoardPatch(input.resolvedDataRequest, input.userPrompt) ??
      buildDashboardAiFallbackBoardPatch({
        userPrompt: input.userPrompt,
        preferredTool: 'compose_dashboard_ai_board',
      }),
    toolTraceSummary: [
      {
        tool: 'query_dashboard_data',
        status: 'executed',
        reason: 'ÄÃ£ tá»± resolve dá»¯ liá»‡u dashboard local read-only cho so sÃ¡nh chi tiáº¿t.',
      },
      {
        tool: 'compose_dashboard_ai_board',
        status: 'accepted',
        reason: 'ÄÃ£ render block notebook deterministic tá»« so sÃ¡nh local Ä‘Ã£ resolve.',
      },
    ],
  };
}

function buildDashboardAiResolvedDataBoardPatch(
  resolvedDataRequest: DashboardAiResolvedDataRequest,
  userPrompt: string
): DashboardAiBoardPatch | null {
  const comparison = resolvedDataRequest.comparison;
  if (!comparison) return null;
  const driverRows = comparison.drivers.map((driver) => ({
    driver: driver.label,
    current: driver.currentValue,
    previous: driver.previousValue,
    delta: driver.delta,
    deltaPct: driver.deltaPct == null ? null : Number((driver.deltaPct * 100).toFixed(1)),
    contributionPct: driver.ctgPct == null ? null : Number((driver.ctgPct * 100).toFixed(1)),
    shareShiftPct: driver.shareShift == null ? null : Number((driver.shareShift * 100).toFixed(1)),
  }));
  const sourceQueryId = `resolved-${comparison.currentPeriod}-vs-${comparison.previousPeriod}`;
  return resolveDashboardAiBoardPatch({
    title: comparisonDifferenceBoardTitle(userPrompt),
    append: false,
    blocks: [
      {
        id: 'resolved-comparison-table',
        type: 'table',
        title: 'Bảng driver từ dữ liệu đã truy vấn',
        source: 'resolvedDataRequest',
        table: {
          templateId: 'custom-table',
          title: 'Bảng driver từ dữ liệu đã truy vấn',
          source: 'resolvedDataRequest',
          sourceQueryId,
          columns: ['driver', 'current', 'previous', 'delta', 'deltaPct', 'contributionPct', 'shareShiftPct'],
          rows: driverRows,
          filters: {
            currentPeriod: comparison.currentPeriod,
            previousPeriod: comparison.previousPeriod,
            metric: comparison.metric,
            dimension: comparison.dimension,
            typeFilter: comparison.typeFilter,
          },
          limit: driverRows.length,
        },
      },
      {
        id: 'resolved-comparison-waterfall',
        type: 'chart',
        title: 'Waterfall driver từ dữ liệu đã truy vấn',
        source: 'resolvedDataRequest',
        chart: {
          chartType: 'waterfall',
          title: 'Waterfall driver từ dữ liệu đã truy vấn',
          source: 'resolvedDataRequest',
          sourceQueryId,
          x: 'driver',
          series: ['delta'],
          rows: driverRows,
          filters: {
            currentPeriod: comparison.currentPeriod,
            previousPeriod: comparison.previousPeriod,
            metric: comparison.metric,
            dimension: comparison.dimension,
            typeFilter: comparison.typeFilter,
          },
          limit: driverRows.length,
        },
      },
      workspaceInsightBlock('resolved-comparison-notes', 'Ghi chú dữ liệu', 'resolvedDataRequest', [
        `Nguồn: dữ liệu đã truy vấn độc lập cho ${comparison.periodLabels.current} so với ${comparison.periodLabels.previous}.`,
        'AI Workspace không dùng bảng MoM/WoW hiện tại để dựng block này.',
      ], 'data-quality-notes'),
    ],
  });
}

export function resolveDashboardAiExportAction(value: unknown): DashboardAiExportAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== 'xlsx') return null;
  if (raw.type === 'dashboard-custom-workbook') {
    const workbookSpec = sanitizeDashboardCustomWorkbookSpec(raw.workbookSpec);
    if (!workbookSpec) return null;
    return {
      type: 'dashboard-custom-workbook',
      format: 'xlsx',
      fileName: sanitizeWorkbookFileName(raw.fileName, workbookSpec.title),
      workbookSpec,
    };
  }
  if (raw.type !== 'dashboard-template-export' && raw.type !== 'dashboard-analysis-export') return null;
  if (raw.templateId === 'mom-wow-analysis' && raw.fileName === 'mom-wow-analysis.xlsx') {
    return {
      type: 'dashboard-template-export',
      templateId: 'mom-wow-analysis',
      format: 'xlsx',
      fileName: 'mom-wow-analysis.xlsx',
    };
  }
  if (raw.templateId === 'sanluong-summary' && raw.fileName === 'sanluong-summary.xlsx') {
    return {
      type: 'dashboard-template-export',
      templateId: 'sanluong-summary',
      format: 'xlsx',
      fileName: 'sanluong-summary.xlsx',
    };
  }
  return null;
}

export function resolveDashboardAiVisualReport(
  value: unknown,
  allowedTemplates: DashboardVisualReportTemplateId[] = DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS
): DashboardVisualReportSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const templateId = optionalEnum(raw.templateId, allowedTemplates as readonly DashboardVisualReportTemplateId[]);
  if (!templateId) return null;
  if (!Array.isArray(raw.blocks)) return null;
  const filters = sanitizeVisualReportFilters(raw.filters);
  const blocks: DashboardVisualReportBlock[] = [];
  for (const blockValue of raw.blocks.slice(0, DASHBOARD_VISUAL_REPORT_LIMITS.maxBlocks)) {
    const block = sanitizeVisualReportBlock(blockValue, blocks.length);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return {
    templateId,
    title: sanitizeVisualText(raw.title, visualTemplateTitle(templateId), 80),
    filters,
    blocks,
    insights: sanitizeVisualTextList(raw.insights, DASHBOARD_VISUAL_REPORT_LIMITS.maxInsights),
    dataQualityNotes: sanitizeVisualTextList(raw.dataQualityNotes, DASHBOARD_VISUAL_REPORT_LIMITS.maxNotes),
  };
}

export function normalizeDashboardAiWorkspaceSeasonIds(
  seasonIds: unknown,
  maxSeasons = DASHBOARD_AI_WORKSPACE_LIMITS.maxSeasons
): string[] {
  if (!Array.isArray(seasonIds)) return [];
  const normalized: string[] = [];
  for (const entry of seasonIds) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value || normalized.includes(value)) continue;
    normalized.push(value);
    if (normalized.length >= maxSeasons) break;
  }
  return normalized;
}

export function buildDashboardAiWorkspaceBoard(input: {
  seasonIds: string[];
  title?: string;
  blocks?: DashboardAiWorkspaceBlock[];
  now?: Date;
}): DashboardAiWorkspaceBoard {
  const now = input.now?.getTime() ?? Date.now();
  const seasonIds = normalizeDashboardAiWorkspaceSeasonIds(input.seasonIds);
  return {
    id: `dashboard-ai-board-${seasonIds.join('-') || 'global'}`,
    title: sanitizeVisualText(input.title, 'AI Workspace Board', 80),
    seasonIds,
    blocks: (input.blocks ?? []).slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks),
    createdAt: now,
    updatedAt: now,
  };
}

export function applyDashboardAiWorkspaceBoardPatch(
  board: DashboardAiWorkspaceBoard,
  patch: DashboardAiBoardPatch | null | undefined,
  options: { now?: Date } = {}
): DashboardAiWorkspaceBoard {
  if (!patch) return board;
  const nextBlocks = patch.append
    ? [...board.blocks, ...patch.blocks].slice(-DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks)
    : patch.blocks.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks);
  return {
    ...board,
    title: patch.title || board.title,
    blocks: nextBlocks,
    updatedAt: options.now?.getTime() ?? Date.now(),
  };
}

export function resolveDashboardAiBoardPatch(value: unknown): DashboardAiBoardPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.blocks)) return null;
  const blocks: DashboardAiWorkspaceBlock[] = [];
  for (const blockValue of raw.blocks.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks)) {
    const block = sanitizeDashboardAiWorkspaceBlock(blockValue, blocks.length);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return {
    title: sanitizeVisualText(raw.title, 'AI Workspace Board', 80),
    blocks,
    append: raw.append === true,
  };
}

export function resolveDashboardAiQueryResults(value: unknown): DashboardAiQueryResult[] {
  if (!Array.isArray(value)) return [];
  const allowedViews: DashboardAiReportingView[] = [...DASHBOARD_AI_REPORTING_VIEWS];
  const results: DashboardAiQueryResult[] = [];
  for (const entry of value.slice(0, DASHBOARD_AI_MAX_ROUNDS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const view = optionalEnum(raw.view, allowedViews as readonly DashboardAiReportingView[]);
    if (!view) continue;
    const queryId = sanitizeBlockId(raw.queryId, `query-${results.length + 1}`);
    const tableData = sanitizeQueryTableData(raw.rows, raw.columns);
    if (tableData.columns.length === 0) continue;
    const rowCount = typeof raw.rowCount === 'number' && Number.isFinite(raw.rowCount)
      ? Math.max(0, Math.floor(raw.rowCount))
      : tableData.rows.length;
    results.push({
      queryId,
      view,
      columns: tableData.columns,
      rows: tableData.rows,
      rowCount,
      truncated: raw.truncated === true,
      dataQualityNotes: sanitizeVisualTextList(raw.dataQualityNotes, DASHBOARD_VISUAL_REPORT_LIMITS.maxNotes),
    });
  }
  return results;
}

export function buildDashboardAiBoardPatchFromQueryResults(
  queryResults: DashboardAiQueryResult[],
  userPrompt: string
): DashboardAiBoardPatch | null {
  const dailyPeak = queryResults.find((result) => result.queryId === 'peak-day-daily');
  if (dailyPeak?.rows.length) {
    const normalizedPrompt = normalizePromptForToolRouting(userPrompt);
    const requiresRestBaseline = /\b(so voi cac ngay con lai|cac ngay con lai|ngay con lai|baseline|bat thuong|anomaly)\b/.test(normalizedPrompt);
    const drilldown = queryResults.find((result) => result.queryId === 'peak-day-drilldown');
    const peakRow = [...dailyPeak.rows]
      .sort((left, right) => Number(right.flights ?? 0) - Number(left.flights ?? 0))[0];
    const peakDate = String(peakRow?.ops_date ?? '');
    const peakFlights = Number(peakRow?.flights ?? 0);
    const averageFlights = dailyPeak.rows.length 
      ? dailyPeak.rows.reduce((sum, row) => sum + Number(row.flights ?? 0), 0) / dailyPeak.rows.length 
      : 0; 
    const delta = peakFlights - averageFlights; 
    const drilldownRows = drilldown?.rows ?? []; 
    const airlineDriverRows = drilldownRows.length > 0 ? aggregateDashboardAiDriverRows(drilldownRows, 'airline') : []; 
    const routeDriverRows = drilldownRows.length > 0 ? aggregateDashboardAiDriverRows(drilldownRows, 'route') : []; 
    const hourDriverRows = drilldownRows.length > 0 ? aggregateDashboardAiDriverRows(drilldownRows, 'local_hour') : []; 
    const airlineBaselineRows = normalizeDashboardAiBaselineDriverRows(queryResults.find((result) => result.queryId === 'peak-day-airline-baseline')?.rows ?? [], 'airline'); 
    const routeBaselineRows = normalizeDashboardAiBaselineDriverRows(queryResults.find((result) => result.queryId === 'peak-day-route-baseline')?.rows ?? [], 'route'); 
    const hourBaselineRows = normalizeDashboardAiBaselineDriverRows(queryResults.find((result) => result.queryId === 'peak-day-hour-baseline')?.rows ?? [], 'local_hour'); 
    const hasRestBaseline = airlineBaselineRows.length > 0 || routeBaselineRows.length > 0 || hourBaselineRows.length > 0;
    const allowSameDayDriverFallback = !requiresRestBaseline;
    const topAirline = airlineDriverRows[0]; 
    const topRoute = routeDriverRows[0]; 
    const topAirlineBaseline = airlineBaselineRows[0]; 
    const topRouteBaseline = routeBaselineRows[0]; 
    return resolveDashboardAiBoardPatch({ 
      title: 'Phân tích ngày cao điểm', 
      blocks: [ 
        {
          id: 'peak-day-summary',
          type: 'rich-markdown',
          title: 'Kết luận ngày cao điểm', 
          source: 'resolvedDataRequest', 
          markdown: { 
            content: [
              '### Ngày cao điểm trong tháng',
              '',
              `Ngày cao điểm là **${peakDate || 'chưa xác định'}** với **${peakFlights.toLocaleString('en-US')} chuyến**. Chênh lệch so với trung bình ngày trong tháng là **${delta >= 0 ? '+' : ''}${delta.toFixed(1)} chuyến/ngày**.`,
              topAirlineBaseline ? `Bất thường theo hãng lớn nhất là **${topAirlineBaseline.airline}**: cao hơn baseline các ngày còn lại **${formatSignedDashboardAiNumber(topAirlineBaseline.delta_vs_baseline)} chuyến/ngày**.` : allowSameDayDriverFallback && topAirline ? `Driver theo hãng nổi bật nhất trong ngày này là **${topAirline.airline}** với **${topAirline.flights} chuyến**.` : '',
              topRouteBaseline ? `Bất thường theo đường bay lớn nhất là **${topRouteBaseline.route}**: cao hơn baseline các ngày còn lại **${formatSignedDashboardAiNumber(topRouteBaseline.delta_vs_baseline)} chuyến/ngày**.` : allowSameDayDriverFallback && topRoute ? `Driver theo đường bay nổi bật nhất là **${topRoute.route}** với **${topRoute.flights} chuyến**.` : '',
              requiresRestBaseline && !hasRestBaseline ? 'Chưa có baseline theo các ngày còn lại nên không dùng drilldown nội-ngày làm kết luận bất thường.' : '',
              '',
              'rendered_rich_chat',
            ].filter(Boolean).join('\n'), 
          }, 
        }, 
        {
          id: 'peak-day-daily-table',
          type: 'table',
          title: 'Phân bổ chuyến bay theo ngày',
          source: 'resolvedDataRequest',
          table: {
            templateId: 'custom-table',
            title: 'Phân bổ chuyến bay theo ngày',
            columns: dailyPeak.columns,
            rows: dailyPeak.rows,
            source: 'resolvedDataRequest',
            sourceQueryId: dailyPeak.queryId,
            filters: {},
            limit: dailyPeak.rows.length,
          },
        },
        {
          id: 'peak-day-daily-chart',
          type: 'chart',
          title: 'Xu hướng chuyến bay từng ngày',
          source: 'resolvedDataRequest',
          chart: {
            chartType: 'line-trend',
            title: 'Xu hướng chuyến bay từng ngày',
            source: 'resolvedDataRequest',
            sourceQueryId: dailyPeak.queryId,
            x: 'ops_date',
            series: ['flights'],
            rows: dailyPeak.rows,
            limit: dailyPeak.rows.length,
          },
        },
        ...(drilldown && allowSameDayDriverFallback ? [{
          id: 'peak-day-drilldown-table',
          type: 'table',
          title: `Drilldown ngày cao điểm ${peakDate}`,
          source: 'resolvedDataRequest',
          table: {
            templateId: 'custom-table',
            title: `Drilldown ngày cao điểm ${peakDate}`,
            columns: drilldown.columns,
            rows: drilldown.rows,
            source: 'resolvedDataRequest',
            sourceQueryId: drilldown.queryId,
            filters: {},
            limit: drilldown.rows.length, 
          }, 
        }] : []), 
        ...(airlineBaselineRows.length ? [{ 
          id: 'peak-day-baseline-airline-table', 
          type: 'table', 
          title: 'Bất thường theo hãng so với các ngày còn lại', 
          source: 'resolvedDataRequest', 
          table: { 
            templateId: 'custom-table', 
            title: 'Bất thường theo hãng so với các ngày còn lại', 
            columns: ['airline', 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'], 
            rows: airlineBaselineRows, 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-airline-baseline', 
            filters: {}, 
            limit: Math.min(12, airlineBaselineRows.length), 
          }, 
        }] : allowSameDayDriverFallback && airlineDriverRows.length ? [{ 
          id: 'peak-day-driver-airline-table', 
          type: 'table', 
          title: 'Driver ngày cao điểm theo hãng bay', 
          source: 'resolvedDataRequest', 
          table: { 
            templateId: 'custom-table', 
            title: 'Driver ngày cao điểm theo hãng bay', 
            columns: ['airline', 'flights', 'pax', 'share'], 
            rows: airlineDriverRows, 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-drilldown', 
            filters: {}, 
            limit: Math.min(12, airlineDriverRows.length), 
          }, 
        }] : []), 
        ...(routeBaselineRows.length ? [{ 
          id: 'peak-day-baseline-route-table', 
          type: 'table', 
          title: 'Bất thường theo đường bay so với các ngày còn lại', 
          source: 'resolvedDataRequest', 
          table: { 
            templateId: 'custom-table', 
            title: 'Bất thường theo đường bay so với các ngày còn lại', 
            columns: ['route', 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'], 
            rows: routeBaselineRows, 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-route-baseline', 
            filters: {}, 
            limit: Math.min(12, routeBaselineRows.length), 
          }, 
        }] : allowSameDayDriverFallback && routeDriverRows.length ? [{ 
          id: 'peak-day-driver-route-table', 
          type: 'table', 
          title: 'Driver ngày cao điểm theo đường bay', 
          source: 'resolvedDataRequest', 
          table: { 
            templateId: 'custom-table', 
            title: 'Driver ngày cao điểm theo đường bay', 
            columns: ['route', 'flights', 'pax', 'share'], 
            rows: routeDriverRows, 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-drilldown', 
            filters: {}, 
            limit: Math.min(12, routeDriverRows.length), 
          }, 
        }] : []), 
        ...(hourBaselineRows.length ? [{ 
          id: 'peak-day-baseline-hour-chart', 
          type: 'chart', 
          title: 'Bất thường theo khung giờ so với các ngày còn lại', 
          source: 'resolvedDataRequest', 
          chart: { 
            chartType: 'bar-ranking', 
            title: 'Bất thường theo khung giờ so với các ngày còn lại', 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-hour-baseline', 
            x: 'local_hour', 
            series: ['delta_vs_baseline'], 
            rows: hourBaselineRows, 
            filters: {}, 
            limit: Math.min(24, hourBaselineRows.length), 
          }, 
        }] : allowSameDayDriverFallback && hourDriverRows.length ? [{ 
          id: 'peak-day-driver-hour-chart', 
          type: 'chart', 
          title: 'Driver ngày cao điểm theo khung giờ', 
          source: 'resolvedDataRequest', 
          chart: { 
            chartType: 'bar-ranking', 
            title: 'Driver ngày cao điểm theo khung giờ', 
            source: 'resolvedDataRequest', 
            sourceQueryId: 'peak-day-drilldown', 
            x: 'local_hour', 
            series: ['flights'], 
            rows: hourDriverRows, 
            filters: {}, 
            limit: Math.min(24, hourDriverRows.length), 
          }, 
        }] : []), 
        ...(airlineBaselineRows.length || routeBaselineRows.length ? [{ 
          id: 'peak-day-driver-insights', 
          type: 'insight-list', 
          title: 'Nhận định driver bất thường', 
          source: 'resolvedDataRequest', 
          insights: [ 
            topAirlineBaseline ? `Driver theo hãng so với baseline các ngày còn lại: ${topAirlineBaseline.airline} cao hơn trung bình ${formatSignedDashboardAiNumber(topAirlineBaseline.delta_vs_baseline)} chuyến/ngày (ngày cao điểm ${topAirlineBaseline.peak_flights}, baseline ${topAirlineBaseline.baseline_avg_flights}; ${formatSignedDashboardAiPercent(topAirlineBaseline.delta_pct)}).` : '', 
            topRouteBaseline ? `Driver theo đường bay so với baseline các ngày còn lại: ${topRouteBaseline.route} cao hơn trung bình ${formatSignedDashboardAiNumber(topRouteBaseline.delta_vs_baseline)} chuyến/ngày (ngày cao điểm ${topRouteBaseline.peak_flights}, baseline ${topRouteBaseline.baseline_avg_flights}; ${formatSignedDashboardAiPercent(topRouteBaseline.delta_pct)}).` : '', 
            'Các driver trên được tính bằng chênh lệch giữa ngày cao điểm và baseline trung bình của các ngày còn lại trong tháng.', 
          ].filter(Boolean), 
        }] : allowSameDayDriverFallback && (airlineDriverRows.length || routeDriverRows.length) ? [{ 
          id: 'peak-day-driver-insights', 
          type: 'insight-list', 
          title: 'Nhận định driver bất thường', 
          source: 'resolvedDataRequest', 
          insights: [ 
            topAirline ? `Driver theo hãng: ${topAirline.airline} đóng góp lớn nhất trong drilldown ngày cao điểm với ${topAirline.flights} chuyến (${topAirline.share}).` : '', 
            topRoute ? `Driver theo đường bay: ${topRoute.route} nổi bật nhất với ${topRoute.flights} chuyến (${topRoute.share}).` : '', 
            'Đây là phân rã trong ngày cao điểm; nếu cần bất thường so với baseline ngày thường, hãy dùng thêm baseline theo tuần/tháng/cùng kỳ.', 
          ].filter(Boolean), 
        }] : []), 
        ...(requiresRestBaseline && !hasRestBaseline ? [{
          id: 'peak-day-baseline-required',
          type: 'data-quality-notes',
          title: 'Thiếu baseline so với các ngày còn lại',
          source: 'resolvedDataRequest',
          insights: [
            'Prompt yêu cầu tìm điểm bất thường của ngày cao điểm so với các ngày còn lại, nhưng kết quả hiện tại chưa có query baseline theo hãng/đường bay/khung giờ.',
            'Không dùng phân rã trong chính ngày cao điểm để kết luận bất thường, vì đó chỉ là cơ cấu nội-ngày.',
          ],
        }] : []),
        { 
          id: 'peak-day-notes', 
          type: 'data-quality-notes',
          title: 'Ghi chú truy vấn',
          source: 'resolvedDataRequest',
          insights: queryResults.flatMap((result) => result.dataQualityNotes).slice(0, 6),
        },
      ],
      append: false,
    });
  }
  const monthComparison = queryResults.find((result) => result.queryId.startsWith('month-comparison-') && result.rows.length > 0);
  if (monthComparison) {
    const dimension = monthComparison.queryId.replace('month-comparison-', '') || monthComparison.columns[0] || 'dimension';
    const dimensionLabel = dimension === 'airline'
      ? 'hãng bay'
      : dimension === 'route'
        ? 'đường bay'
        : dimension === 'country'
          ? 'quốc gia'
          : dimension === 'aircraft'
            ? 'tàu bay'
            : dimension === 'type'
              ? 'ARR/DEP'
              : 'khung giờ';
    const topDelta = [...monthComparison.rows]
      .sort((left, right) => Math.abs(Number(right.delta_flights ?? 0)) - Math.abs(Number(left.delta_flights ?? 0)))[0];
    const topLabel = String(topDelta?.[dimension] ?? 'N/A');
    const topDeltaFlights = Number(topDelta?.delta_flights ?? 0);
    return resolveDashboardAiBoardPatch({
      title: `So sánh theo ${dimensionLabel} từ truy vấn độc lập`,
      blocks: [
        {
          id: 'month-comparison-summary',
          type: 'rich-markdown',
          title: 'Kết luận so sánh',
          source: 'resolvedDataRequest',
          markdown: {
            content: [
              `### So sánh theo ${dimensionLabel}`,
              '',
              `Bảng dưới đây được tạo trực tiếp từ SQLite local, không dùng bảng MoM/WoW. Driver biến động lớn nhất là **${topLabel}** với **${topDeltaFlights >= 0 ? '+' : ''}${topDeltaFlights.toLocaleString('en-US')} chuyến**.`,
              'rendered_rich_chat',
            ].join('\n'),
          },
        },
        {
          id: 'month-comparison-table',
          type: 'table',
          title: `Bảng driver theo ${dimensionLabel}`,
          source: 'resolvedDataRequest',
          table: {
            templateId: 'custom-table',
            title: `Bảng driver theo ${dimensionLabel}`,
            columns: monthComparison.columns,
            rows: monthComparison.rows,
            source: 'resolvedDataRequest',
            sourceQueryId: monthComparison.queryId,
            filters: {},
            limit: monthComparison.rows.length,
          },
        },
        {
          id: 'month-comparison-waterfall',
          type: 'chart',
          title: `Waterfall biến động theo ${dimensionLabel}`,
          source: 'resolvedDataRequest',
          chart: {
            chartType: 'waterfall',
            title: `Waterfall biến động theo ${dimensionLabel}`,
            source: 'resolvedDataRequest',
            sourceQueryId: monthComparison.queryId,
            x: dimension,
            series: ['delta_flights'],
            rows: monthComparison.rows,
            filters: {},
            limit: Math.min(24, monthComparison.rows.length),
          },
        },
        {
          id: 'month-comparison-notes',
          type: 'data-quality-notes',
          title: 'Ghi chú truy vấn',
          source: 'resolvedDataRequest',
          insights: monthComparison.dataQualityNotes.length > 0
            ? monthComparison.dataQualityNotes
            : ['Nguồn: SQLite local, truy vấn độc lập theo prompt.'],
        },
      ],
      append: false,
    });
  }
  const first = queryResults[0];
  if (!first || first.columns.length === 0) return null;
  const prompt = normalizePromptForToolRouting(userPrompt);
  const numericColumns = first.columns.filter((column) => first.rows.some((row) => typeof row[column] === 'number'));
  const labelColumn = first.columns.find((column) => !numericColumns.includes(column)) ?? first.columns[0] ?? 'label';
  const primaryMetric = numericColumns.find((column) => /pax/i.test(column)) ??
    numericColumns.find((column) => /flight|chuyen|chuyáº¿n|value|delta/i.test(column)) ??
    numericColumns[0] ??
    'value';
  const chartType: DashboardAiWorkspaceChartType = /\b(heatmap|ban do nhiet|báº£n Ä‘á»“ nhiá»‡t)\b/.test(prompt)
    ? 'heatmap'
    : /\b(waterfall|driver|bien dong|biáº¿n Ä‘á»™ng|delta)\b/.test(prompt)
      ? 'waterfall'
      : /\b(trend|weekly|hang tuan|hÃ ng tuáº§n|month|thang|thÃ¡ng)\b/.test(prompt)
        ? 'line-trend'
        : 'bar-ranking';
  const blocks: DashboardAiWorkspaceBlock[] = [
    {
      id: `${first.queryId}-table`,
      type: 'table',
      title: 'Báº£ng dá»¯ liá»‡u AI Ä‘Ã£ truy váº¥n',
      source: 'resolvedDataRequest',
      table: {
        templateId: 'custom-table',
        title: 'Báº£ng dá»¯ liá»‡u AI Ä‘Ã£ truy váº¥n',
        columns: first.columns,
        rows: first.rows,
        source: 'resolvedDataRequest',
        sourceQueryId: first.queryId,
        filters: {},
        limit: first.rows.length,
      },
    },
  ];
  if (numericColumns.length > 0) {
    blocks.push({
      id: `${first.queryId}-chart`,
      type: 'chart',
      title: 'Biá»ƒu Ä‘á»“ dá»¯ liá»‡u AI Ä‘Ã£ truy váº¥n',
      source: 'resolvedDataRequest',
      chart: {
        chartType,
        title: 'Biá»ƒu Ä‘á»“ dá»¯ liá»‡u AI Ä‘Ã£ truy váº¥n',
        source: 'resolvedDataRequest',
        sourceQueryId: first.queryId,
        x: labelColumn,
        series: [primaryMetric],
        rows: first.rows,
        filters: {},
        limit: first.rows.length,
      },
    });
  }
  const notes = first.dataQualityNotes.length > 0
    ? first.dataQualityNotes
    : [`ÄÃ£ truy váº¥n ${first.rowCount.toLocaleString('en-US')} dÃ²ng tá»« reporting.${first.view}${first.truncated ? ', káº¿t quáº£ Ä‘Ã£ Ä‘Æ°á»£c giá»›i háº¡n.' : '.'}`];
  blocks.push({
    id: `${first.queryId}-notes`,
    type: 'data-quality-notes',
    title: 'Ghi chÃº dá»¯ liá»‡u',
    source: 'resolvedDataRequest',
    insights: notes,
  });
  return {
    title: 'Káº¿t quáº£ truy váº¥n dá»¯ liá»‡u AI',
    blocks: blocks.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlocks),
    append: false,
  };
}

export function shouldPreferDashboardAiQueryResults(input: { 
  userPrompt: string; 
  queryResults?: DashboardAiQueryResult[] | null; 
  boardPatch?: DashboardAiBoardPatch | null; 
}): boolean { 
  const queryResults = input.queryResults ?? []; 
  if (!queryResults.some((result) => result.rows.length > 0)) return false; 
  if (!isDashboardAiQueryIntentPrompt(input.userPrompt)) return false; 
  const normalizedPrompt = normalizePromptForToolRouting(input.userPrompt);
  if (/\b(driver|phan tich driver|phan ra|dong luc|bat thuong|diem bat thuong|cao diem|ngay cao diem)\b/.test(normalizedPrompt)) return true;
  if (/\bcao\b/.test(normalizedPrompt) && queryResults.some((result) => result.queryId.startsWith('peak-day-'))) return true;
  const queryIds = new Set(queryResults.map((result) => result.queryId).filter(Boolean)); 
  if (!input.boardPatch) return true;
  return !input.boardPatch.blocks.some((block) => {
    const sourceQueryId = block.table?.sourceQueryId ?? block.chart?.sourceQueryId;
    return sourceQueryId ? queryIds.has(sourceQueryId) : false;
  }); 
} 

export function buildDashboardAiFollowUpBoardPatchFromCells(input: {
  userPrompt: string;
  cells: DashboardAiNotebookCell[];
}): DashboardAiBoardPatch | null {
  const resolution = resolveDashboardAiSessionFollowUp(input);
  if (resolution?.boardPatch) return resolution.boardPatch;
  const normalized = normalizePromptForToolRouting(input.userPrompt);
  const isDriverFollowUp = isDashboardAiSessionFollowUpPrompt(normalized) &&
    /\b(driver|phan tich driver|phan ra|dong luc|tai sao|bat thuong|diem bat thuong|ngay do)\b/.test(normalized);
  if (!isDriverFollowUp) return null;
  const sourceCell = [...input.cells].reverse().find((cell) =>
    cell.blocks.some((block) =>
      block.table?.sourceQueryId === 'peak-day-daily' ||
      block.table?.sourceQueryId === 'peak-day-drilldown' ||
      block.id === 'peak-day-daily-table' ||
      block.id === 'peak-day-drilldown-table'
    )
  );
  if (!sourceCell) return null;
  const dailyRows = sourceCell.blocks.find((block) =>
    block.table?.sourceQueryId === 'peak-day-daily' || block.id === 'peak-day-daily-table'
  )?.table?.rows ?? [];
  const drilldownRows = sourceCell.blocks.find((block) =>
    block.table?.sourceQueryId === 'peak-day-drilldown' || block.id === 'peak-day-drilldown-table'
  )?.table?.rows ?? [];
  if (drilldownRows.length === 0) return null;
  const peakRow = [...dailyRows].sort((left, right) => Number(right.flights ?? 0) - Number(left.flights ?? 0))[0] ?? null;
  const peakDate = String(peakRow?.ops_date ?? peakRow?.date ?? 'ngày cao điểm');
  const peakFlights = Number(peakRow?.flights ?? 0);
  const averageFlights = dailyRows.length
    ? dailyRows.reduce((sum, row) => sum + Number(row.flights ?? 0), 0) / dailyRows.length
    : 0;
  const airlineRows = aggregateDashboardAiDriverRows(drilldownRows, 'airline');
  const routeRows = aggregateDashboardAiDriverRows(drilldownRows, 'route');
  const hourRows = aggregateDashboardAiDriverRows(drilldownRows, 'local_hour');
  const topAirline = airlineRows[0];
  const topRoute = routeRows[0];
  return resolveDashboardAiBoardPatch({
    title: `Driver ngày cao điểm ${peakDate}`,
    blocks: [
      {
        id: 'followup-driver-summary',
        type: 'rich-markdown',
        title: 'Tóm tắt driver từ cell trước',
        source: 'resolvedDataRequest',
        markdown: {
          content: [
            `### Driver ngày cao điểm ${peakDate}`,
            '',
            `Tiếp nối cell trước, phân tích này dùng lại drilldown SQLite local đã render cho ngày cao điểm. Tổng ngày cao điểm: **${peakFlights.toLocaleString('en-US')} chuyến**${averageFlights ? `, so với trung bình khoảng **${averageFlights.toFixed(1)} chuyến/ngày**` : ''}.`,
            topAirline ? `Driver theo hãng nổi bật nhất là **${topAirline.airline}** với **${topAirline.flights} chuyến** trong drilldown.` : '',
            topRoute ? `Driver theo đường bay nổi bật nhất là **${topRoute.route}** với **${topRoute.flights} chuyến**.` : '',
          ].filter(Boolean).join('\n'),
        },
      },
      {
        id: 'followup-driver-airline-table',
        type: 'table',
        title: 'Driver theo hãng bay',
        source: 'resolvedDataRequest',
        table: {
          templateId: 'custom-table',
          title: 'Driver theo hãng bay',
          columns: ['airline', 'flights', 'pax', 'share'],
          rows: airlineRows,
          source: 'resolvedDataRequest',
          sourceQueryId: 'peak-day-drilldown',
          filters: {},
          limit: Math.min(12, airlineRows.length),
        },
      },
      {
        id: 'followup-driver-route-table',
        type: 'table',
        title: 'Driver theo đường bay',
        source: 'resolvedDataRequest',
        table: {
          templateId: 'custom-table',
          title: 'Driver theo đường bay',
          columns: ['route', 'flights', 'pax', 'share'],
          rows: routeRows,
          source: 'resolvedDataRequest',
          sourceQueryId: 'peak-day-drilldown',
          filters: {},
          limit: Math.min(12, routeRows.length),
        },
      },
      {
        id: 'followup-driver-hour-chart',
        type: 'chart',
        title: 'Phân bổ theo khung giờ',
        source: 'resolvedDataRequest',
        chart: {
          chartType: 'bar-ranking',
          title: 'Phân bổ theo khung giờ',
          source: 'resolvedDataRequest',
          sourceQueryId: 'peak-day-drilldown',
          x: 'local_hour',
          series: ['flights'],
          rows: hourRows,
          limit: Math.min(24, hourRows.length),
          filters: {},
        },
      },
      {
        id: 'followup-driver-insights',
        type: 'insight-list',
        title: 'Nhận định driver',
        source: 'resolvedDataRequest',
        insights: [
          'Tiếp nối cell trước: không dùng lại MoM/WoW mặc định khi prompt follow-up ngắn.',
          topAirline ? `${topAirline.airline} là hãng đóng góp lớn nhất trong drilldown ngày cao điểm.` : '',
          topRoute ? `${topRoute.route} là đường bay nổi bật nhất trong drilldown ngày cao điểm.` : '',
          'Nếu cần driver so với baseline khác, hãy hỏi rõ baseline: ngày thường, tuần trước, tháng trước hoặc cùng kỳ.',
        ].filter(Boolean),
      },
    ],
    append: false,
  });
}

function getDashboardAiPromptWordCount(normalizedPrompt: string): number {
  return normalizedPrompt.split(/\s+/).filter(Boolean).length;
}

function hasDashboardAiFreshScopedPromptIntent(normalizedPrompt: string): boolean {
  return /\b(thang|trong thang|month|tuan|week|tu ngay|den ngay|khoang ngay|date range|s\d{2}|w\d{2}|top \d+|top|cao diem cua thang|ngay cao diem cua thang|giua s\d{2}|so sanh tan suat|pax cao nhat)\b/.test(normalizedPrompt);
}

function hasDashboardAiSessionReferencePrompt(normalizedPrompt: string): boolean {
  return /\b(tiep|tiep tuc|phan tich tiep|ngay do|ngay nay|bang tren|bang nay|table tren|chart tren|bieu do tren|cell truoc|cell nay|tu bang|tu ket qua tren|so sanh ngay do|giai thich ngay do|ve them)\b/.test(normalizedPrompt);
}

function isDashboardAiSessionFollowUpPrompt(normalizedPrompt: string): boolean {
  if (hasDashboardAiSessionReferencePrompt(normalizedPrompt)) return true;
  if (hasDashboardAiFreshScopedPromptIntent(normalizedPrompt)) return false;
  const wordCount = getDashboardAiPromptWordCount(normalizedPrompt);
  return wordCount <= 6 &&
    /\b(driver|phan tich driver|phan ra|dong luc|tai sao|bat thuong|diem bat thuong|giai thich bat thuong|tach theo|route|duong bay|hang bay|chart|bieu do)\b/.test(normalizedPrompt);
}

export function resolveDashboardAiSessionFollowUp(input: {
  userPrompt: string;
  cells: DashboardAiNotebookCell[];
  pinnedCellId?: string | null;
}): DashboardAiSessionFollowUpResolution | null {
  const normalized = normalizePromptForToolRouting(input.userPrompt);
  const isFollowUp = isDashboardAiSessionFollowUpPrompt(normalized);
  if (!isFollowUp) return null;
  const sourceCell = resolveDashboardAiActiveCell(input.cells, input.pinnedCellId);
  if (!sourceCell) return null;
  const sourceCellIndex = input.cells.findIndex((cell) => cell.id === sourceCell.id) + 1;
  const activeArtifact = sourceCell.activeArtifact ?? buildDashboardAiActiveArtifactFromCell(sourceCell, { sourceCellIndex });
  const prefix = `Tiếp nối #${sourceCellIndex}: ${activeArtifact.summaryVi}`;
  const wantsChart = /\b(ve them|chart|bieu do|graph|plot|visual)\b/.test(normalized);
  const wantsRoute = /\b(route|duong bay)\b/.test(normalized);
  const wantsDriver = /\b(driver|phan tich driver|bat thuong|diem bat thuong|dong luc|phan ra|giai thich)\b/.test(normalized);
  const queryResults = sourceCell.queryResults ?? [];
  if (wantsChart) {
    const chartPatch = buildDashboardAiChartFromActiveCell(sourceCell, activeArtifact);
    if (chartPatch) {
      return {
        sourceCellId: sourceCell.id,
        sourceCellIndex,
        activeArtifact,
        rewrittenPrompt: `${prefix}. ${input.userPrompt}`,
        assistantText: `${prefix}. Đã vẽ thêm biểu đồ từ bảng/kết quả đang được chọn.`,
        boardPatch: chartPatch,
      };
    }
  }
  const hasRouteResult = queryResults.some((result) => /route/i.test(result.queryId) || result.columns.includes('route'));
  if ((wantsDriver || (wantsRoute && hasRouteResult)) && queryResults.length > 0) {
    const queryPatch = buildDashboardAiBoardPatchFromQueryResults(queryResults, `${input.userPrompt} ${activeArtifact.summaryVi}`);
    if (queryPatch) {
      return {
        sourceCellId: sourceCell.id,
        sourceCellIndex,
        activeArtifact,
        rewrittenPrompt: `${prefix}. ${input.userPrompt}`,
        assistantText: wantsRoute
          ? `${prefix}. Đã dùng lại query result của cell trước để phân tích theo đường bay.`
          : `${prefix}. Đã phân tích driver từ query result của cell trước, không dùng fallback MoM/WoW mặc định.`,
        boardPatch: queryPatch,
      };
    }
  }
  if (wantsRoute && activeArtifact.entities.peakDate) {
    return {
      sourceCellId: sourceCell.id,
      sourceCellIndex,
      activeArtifact,
      rewrittenPrompt: `${prefix}. ${input.userPrompt}`,
      assistantText: `${prefix}. Đang truy vấn lại route cho ngày đang được tham chiếu.`,
      sqlQueryPlans: [{
        queryId: 'followup-route-by-date',
        sql: [
          'SELECT route, COUNT(*) AS flights, SUM(pax) AS pax',
          'FROM dashboard_ai_flight_operations',
          "WHERE ops_date = ? AND COALESCE(status, 'active') != 'deleted'",
          'GROUP BY route',
          'ORDER BY flights DESC, pax DESC',
          'LIMIT 20',
        ].join(' '),
        params: [activeArtifact.entities.peakDate],
        reasonVi: `Tiếp nối ${activeArtifact.summaryVi}: truy vấn đường bay của ngày đang được tham chiếu.`,
        expectedColumns: ['route', 'flights', 'pax'],
        visualizationHint: 'bar-ranking',
        source: 'local-sqlite',
      }],
    };
  }
  return null;
}

function buildDashboardAiChartFromActiveCell(
  cell: DashboardAiNotebookCell,
  activeArtifact: DashboardAiActiveArtifact
): DashboardAiBoardPatch | null {
  const tableBlock = [...cell.blocks].reverse().find((block) => block.table?.rows?.length);
  const rows = tableBlock?.table?.rows ?? [];
  if (rows.length === 0) return null;
  const columns = tableBlock?.table?.columns ?? Object.keys(rows[0] ?? {});
  const x = columns.find((column) => !rows.some((row) => typeof row[column] === 'number')) ?? columns[0] ?? 'label';
  const metric = ['delta_vs_baseline', 'flights', 'pax', 'peak_flights'].find((column) => columns.includes(column)) ?? columns.find((column) => rows.some((row) => typeof row[column] === 'number')) ?? 'flights';
  return resolveDashboardAiBoardPatch({
    title: `Biểu đồ tiếp nối ${activeArtifact.summaryVi}`,
    blocks: [{
      id: 'followup-chart-from-table',
      type: 'chart',
      title: `Biểu đồ từ bảng: ${tableBlock?.title ?? activeArtifact.summaryVi}`,
      source: 'resolvedDataRequest',
      chart: {
        chartType: 'bar-ranking',
        title: `Biểu đồ từ bảng: ${tableBlock?.title ?? activeArtifact.summaryVi}`,
        source: 'resolvedDataRequest',
        sourceQueryId: tableBlock?.table?.sourceQueryId ?? activeArtifact.queryIds[0] ?? 'active-table',
        x,
        series: [metric],
        rows,
        limit: Math.min(12, rows.length),
        filters: {},
      },
    }],
    append: false,
  });
}

function aggregateDashboardAiDriverRows(
  rows: Record<string, DashboardAiQueryCell>[],
  key: 'airline' | 'route' | 'local_hour'
): Record<string, DashboardAiQueryCell>[] {
  const totals = new Map<string, { flights: number; pax: number }>();
  for (const row of rows) {
    const label = String(row[key] ?? '').trim() || 'N/A';
    const current = totals.get(label) ?? { flights: 0, pax: 0 };
    current.flights += Number(row.flights ?? 0);
    current.pax += Number(row.pax ?? 0);
    totals.set(label, current);
  }
  const totalFlights = Array.from(totals.values()).reduce((sum, row) => sum + row.flights, 0);
  return Array.from(totals.entries())
    .map(([label, value]) => ({
      [key]: key === 'local_hour' ? Number(label) : label,
      flights: value.flights,
      pax: value.pax,
      share: totalFlights > 0 ? `${((value.flights / totalFlights) * 100).toFixed(1)}%` : '0.0%',
    }))
    .sort((left, right) => Number(right.flights ?? 0) - Number(left.flights ?? 0) || String(left[key]).localeCompare(String(right[key])))
    .slice(0, key === 'local_hour' ? 24 : 12);
}

function normalizeDashboardAiBaselineDriverRows(
  rows: Record<string, DashboardAiQueryCell>[],
  key: 'airline' | 'route' | 'local_hour'
): Record<string, DashboardAiQueryCell>[] {
  return rows
    .map((row) => ({
      [key]: key === 'local_hour' ? Number(row[key] ?? 0) : String(row[key] ?? 'N/A'),
      peak_flights: Number(row.peak_flights ?? 0),
      baseline_avg_flights: Number(row.baseline_avg_flights ?? 0),
      delta_vs_baseline: Number(row.delta_vs_baseline ?? 0),
      delta_pct: row.delta_pct == null ? null : Number(row.delta_pct),
      peak_pax: Number(row.peak_pax ?? 0),
    }))
    .filter((row) => Number.isFinite(Number(row.delta_vs_baseline)))
    .sort((left, right) =>
      Number(right.delta_vs_baseline ?? 0) - Number(left.delta_vs_baseline ?? 0) ||
      Number(right.peak_flights ?? 0) - Number(left.peak_flights ?? 0) ||
      String(left[key]).localeCompare(String(right[key]))
    )
    .slice(0, key === 'local_hour' ? 24 : 12);
}

function formatSignedDashboardAiNumber(value: DashboardAiQueryCell | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '0.0';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}`;
}

function formatSignedDashboardAiPercent(value: DashboardAiQueryCell | undefined): string {
  if (value == null) return 'không có baseline';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'không có baseline';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}%`;
}

export function inferDashboardAiDataQueryForPrompt(input: { 
  userPrompt: string;
  context?: unknown;
}): DashboardAiDataQuery | null {
  return inferSharedDashboardAiDataQueryFromPrompt(input);
}

export function planDashboardAiSqlQueries(input: {
  userPrompt: string;
  context?: DashboardAiContext | Record<string, unknown> | null;
  source?: DashboardAiDataSourcePolicy;
}): DashboardAiSqlQueryPlan[] {
  const normalized = normalizePromptForToolRouting(input.userPrompt);
  const source = input.source ?? 'local-sqlite';
  const monthPair = inferDashboardAiSqlMonthPair(input.userPrompt, input.context);
  if (monthPair) {
    const dimension = inferDashboardAiComparisonDimension(normalized);
    const dimensionExpr = dimension === 'local_hour'
      ? 'local_hour'
      : dimension;
    const labelVi = dimension === 'airline'
      ? 'hãng bay'
      : dimension === 'route'
        ? 'đường bay'
        : dimension === 'country'
          ? 'quốc gia'
          : dimension === 'aircraft'
            ? 'tàu bay'
            : dimension === 'type'
              ? 'ARR/DEP'
              : 'khung giờ';
    const queryId = `month-comparison-${dimension}`;
    return [{
      queryId,
      sql: [
        `SELECT COALESCE(CAST(${dimensionExpr} AS TEXT), 'N/A') AS ${dimension},`,
        `SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) AS current_flights,`,
        `SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) AS previous_flights,`,
        `SUM(CASE WHEN month = ? THEN pax ELSE 0 END) AS current_pax,`,
        `SUM(CASE WHEN month = ? THEN pax ELSE 0 END) AS previous_pax,`,
        `SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) - SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) AS delta_flights,`,
        `CASE WHEN SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) = 0 THEN NULL ELSE ROUND(((SUM(CASE WHEN month = ? THEN 1 ELSE 0 END) - SUM(CASE WHEN month = ? THEN 1 ELSE 0 END)) * 100.0 / SUM(CASE WHEN month = ? THEN 1 ELSE 0 END)), 1) END AS delta_pct`,
        'FROM dashboard_ai_flight_operations',
        "WHERE month IN (?, ?) AND COALESCE(status, 'active') != 'deleted'",
        `GROUP BY COALESCE(CAST(${dimensionExpr} AS TEXT), 'N/A')`,
        'HAVING current_flights > 0 OR previous_flights > 0',
        'ORDER BY ABS(delta_flights) DESC, current_flights DESC',
        'LIMIT 50',
      ].join(' '),
      params: [
        monthPair.current,
        monthPair.previous,
        monthPair.current,
        monthPair.previous,
        monthPair.current,
        monthPair.previous,
        monthPair.previous,
        monthPair.current,
        monthPair.previous,
        monthPair.previous,
        monthPair.current,
        monthPair.previous,
      ],
      reasonVi: `Truy vấn so sánh ${labelVi} giữa ${monthPair.current} và ${monthPair.previous} bằng SQLite local độc lập, không dùng bảng MoM/WoW.`,
      expectedColumns: [dimension, 'current_flights', 'previous_flights', 'current_pax', 'previous_pax', 'delta_flights', 'delta_pct'],
      visualizationHint: 'waterfall',
      source,
      workflowId: 'month-comparison-drivers',
      comparisonKind: 'period-vs-period',
      primaryMetric: 'delta',
      primaryDimension: dimension,
      renderHints: {
        titleVi: `So sánh ${labelVi} ${monthPair.current} vs ${monthPair.previous}`,
        tableTitleVi: `Bảng driver theo ${labelVi}`,
        chartTitleVi: `Waterfall biến động theo ${labelVi}`,
        x: dimension,
        series: ['delta_flights'],
      },
    }];
  }
  const month = inferSingleDashboardAiSqlMonth(input.userPrompt, input.context);
  const wantsDailyPeak = /\b(ngay|daily|theo ngay|phan bo theo ngay|cao diem|cao|bat thuong|anomaly|bat)\b/.test(normalized) &&
    /\b(cao diem|cao|nhieu nhat|cao nhat|peak|bat thuong|anomaly|bat)\b/.test(normalized);
  if (month && wantsDailyPeak) {
    return [{
      queryId: 'peak-day-daily',
      sql: [
        'SELECT ops_date,',
        'COUNT(*) AS flights,',
        'SUM(pax) AS pax,',
        "SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,",
        "SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures",
        'FROM dashboard_ai_flight_operations',
        "WHERE month = ? AND COALESCE(status, 'active') != 'deleted'",
        'GROUP BY ops_date',
        'ORDER BY flights DESC, ops_date ASC',
        'LIMIT 31',
      ].join(' '),
      params: [month],
      reasonVi: `Truy vấn phân bổ từng ngày trong tháng ${month} để xác định ngày cao điểm và bất thường.`,
      expectedColumns: ['ops_date', 'flights', 'pax', 'arrivals', 'departures'],
      visualizationHint: 'line-trend',
      source,
      workflowId: 'peak-day-anomaly',
      comparisonKind: 'day-vs-baseline',
      primaryMetric: 'flights',
      primaryDimension: 'ops_date',
      renderHints: {
        titleVi: `Ngày cao điểm và bất thường tháng ${month}`,
        tableTitleVi: 'Phân bổ chuyến bay theo ngày',
        chartTitleVi: 'Xu hướng chuyến bay từng ngày',
        x: 'ops_date',
        series: ['flights'],
      },
    }];
  }

  const wantsRoute = /\b(route|duong bay|đường bay)\b/.test(normalized);
  const wantsPax = /\b(pax|khach|khách)\b/.test(normalized);
  if (month && wantsRoute) {
    return [{
      queryId: 'route-ranking-sql',
      sql: [
        'SELECT route, COUNT(*) AS flights, SUM(pax) AS pax',
        'FROM dashboard_ai_flight_operations',
        "WHERE month = ? AND COALESCE(status, 'active') != 'deleted'",
        'GROUP BY route',
        `ORDER BY ${wantsPax ? 'pax' : 'flights'} DESC`,
        'LIMIT 10',
      ].join(' '),
      params: [month],
      reasonVi: `Truy vấn top đường bay trong tháng ${month} theo ${wantsPax ? 'PAX' : 'số chuyến'}.`,
      expectedColumns: ['route', 'flights', 'pax'],
      visualizationHint: 'bar-ranking',
      source,
      workflowId: wantsPax ? 'route-pax-ranking' : 'general-query',
      comparisonKind: 'entity-ranking',
      primaryMetric: wantsPax ? 'pax' : 'flights',
      primaryDimension: 'route',
    }];
  }

  const seasonCodes = Array.from(new Set(Array.from(input.userPrompt.matchAll(/\b[SW]\d{2}\b/gi)).map((match) => match[0].toUpperCase())));
  const wantsAirline = /\b(vn|vietnam airlines|airline|hang bay|hãng bay)\b/i.test(input.userPrompt);
  if (seasonCodes.length >= 2 && wantsAirline) {
    return [{
      queryId: 'cross-season-airline-sql',
      sql: [
        'SELECT season, airline, COUNT(*) AS flights, SUM(pax) AS pax',
        'FROM dashboard_ai_flight_operations',
        "WHERE season IN (?, ?) AND COALESCE(status, 'active') != 'deleted'",
        /\b(vn|vietnam airlines)\b/i.test(input.userPrompt) ? "AND airline = 'VN'" : '',
        'GROUP BY season, airline',
        'ORDER BY season ASC, flights DESC',
        'LIMIT 50',
      ].filter(Boolean).join(' '),
      params: [seasonCodes[0], seasonCodes[1]],
      reasonVi: `Truy vấn so sánh tần suất hãng bay giữa ${seasonCodes[0]} và ${seasonCodes[1]}.`,
      expectedColumns: ['season', 'airline', 'flights', 'pax'],
      visualizationHint: 'bar-ranking',
      source,
      workflowId: 'season-to-season-frequency',
      comparisonKind: 'period-vs-period',
      primaryMetric: 'flights',
      primaryDimension: 'airline',
    }];
  }

  return [];
}

export function planDashboardAiSqlDrilldownQueries(input: {
  userPrompt: string;
  queryResults: DashboardAiQueryResult[];
  source?: DashboardAiDataSourcePolicy;
}): DashboardAiSqlQueryPlan[] {
  const daily = input.queryResults.find((result) => result.queryId === 'peak-day-daily');
  if (!daily?.rows.length) return [];
  const peak = [...daily.rows]
    .sort((left, right) => Number(right.flights ?? 0) - Number(left.flights ?? 0))[0];
  const peakDate = typeof peak?.ops_date === 'string' ? peak.ops_date : null;
  if (!peakDate) return [];
  const month = peakDate.slice(0, 7);
  const otherDayCount = Math.max(1, daily.rows.filter((row) => String(row.ops_date ?? '') !== peakDate).length);
  const source = input.source ?? 'local-sqlite';
  const plans: DashboardAiSqlQueryPlan[] = [{
    queryId: 'peak-day-drilldown',
    sql: [
      'SELECT airline, route, local_hour, type, COUNT(*) AS flights, SUM(pax) AS pax',
      'FROM dashboard_ai_flight_operations',
      "WHERE ops_date = ? AND COALESCE(status, 'active') != 'deleted'",
      'GROUP BY airline, route, local_hour, type',
      'ORDER BY flights DESC, pax DESC',
      'LIMIT 24',
    ].join(' '),
    params: [peakDate],
    reasonVi: `Drilldown ngày cao điểm ${peakDate} theo hãng bay, đường bay, khung giờ và ARR/DEP.`,
    expectedColumns: ['airline', 'route', 'local_hour', 'type', 'flights', 'pax'],
    visualizationHint: 'bar-ranking',
    source,
  }];
  plans.push(
    buildDashboardAiPeakDayBaselineSqlPlan('airline', peakDate, month, otherDayCount, source),
    buildDashboardAiPeakDayBaselineSqlPlan('route', peakDate, month, otherDayCount, source),
    buildDashboardAiPeakDayBaselineSqlPlan('local_hour', peakDate, month, otherDayCount, source)
  );
  return plans;
}

function buildDashboardAiPeakDayBaselineSqlPlan(
  dimension: 'airline' | 'route' | 'local_hour',
  peakDate: string,
  month: string,
  otherDayCount: number,
  source: DashboardAiDataSourcePolicy
): DashboardAiSqlQueryPlan {
  const dimensionExpr = dimension === 'local_hour'
    ? "COALESCE(CAST(local_hour AS TEXT), 'N/A')"
    : `COALESCE(${dimension}, 'N/A')`;
  const outputDimensionExpr = dimension === 'local_hour'
    ? `CAST(k.dimension_value AS INTEGER) AS ${dimension}`
    : `k.dimension_value AS ${dimension}`;
  const queryId = dimension === 'airline'
    ? 'peak-day-airline-baseline'
    : dimension === 'route'
      ? 'peak-day-route-baseline'
      : 'peak-day-hour-baseline';
  const labelVi = dimension === 'airline' ? 'hãng bay' : dimension === 'route' ? 'đường bay' : 'khung giờ';
  const limit = dimension === 'local_hour' ? 24 : 12;
  return {
    queryId,
    sql: [
      'WITH peak AS (',
      `SELECT ${dimensionExpr} AS dimension_value, COUNT(*) AS peak_flights, SUM(pax) AS peak_pax`,
      'FROM dashboard_ai_flight_operations',
      "WHERE ops_date = ? AND COALESCE(status, 'active') != 'deleted'",
      `GROUP BY ${dimensionExpr}`,
      '), baseline AS (',
      `SELECT ${dimensionExpr} AS dimension_value, COUNT(*) AS baseline_total_flights`,
      'FROM dashboard_ai_flight_operations',
      "WHERE month = ? AND ops_date != ? AND COALESCE(status, 'active') != 'deleted'",
      `GROUP BY ${dimensionExpr}`,
      '), keys AS (',
      'SELECT dimension_value FROM peak UNION SELECT dimension_value FROM baseline',
      ')',
      `SELECT ${outputDimensionExpr},`,
      'COALESCE(p.peak_flights, 0) AS peak_flights,',
      'ROUND(COALESCE(b.baseline_total_flights, 0) * 1.0 / ?, 1) AS baseline_avg_flights,',
      'ROUND(COALESCE(p.peak_flights, 0) - (COALESCE(b.baseline_total_flights, 0) * 1.0 / ?), 1) AS delta_vs_baseline,',
      'CASE WHEN COALESCE(b.baseline_total_flights, 0) = 0 THEN NULL ELSE ROUND(((COALESCE(p.peak_flights, 0) - (COALESCE(b.baseline_total_flights, 0) * 1.0 / ?)) / (COALESCE(b.baseline_total_flights, 0) * 1.0 / ?)) * 100, 1) END AS delta_pct,',
      'COALESCE(p.peak_pax, 0) AS peak_pax',
      'FROM keys k',
      'LEFT JOIN peak p ON p.dimension_value = k.dimension_value',
      'LEFT JOIN baseline b ON b.dimension_value = k.dimension_value',
      'ORDER BY delta_vs_baseline DESC, peak_flights DESC',
      `LIMIT ${limit}`,
    ].join(' '),
    params: [peakDate, month, peakDate, otherDayCount, otherDayCount, otherDayCount, otherDayCount],
    reasonVi: `So sánh ${labelVi} của ngày cao điểm ${peakDate} với baseline trung bình các ngày còn lại trong tháng ${month}.`,
    expectedColumns: [dimension, 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'],
    visualizationHint: 'bar-ranking',
    source,
  };
}

export function dashboardAiSqlResultToQueryResult(
  plan: DashboardAiSqlQueryPlan,
  result: {
    columns: string[];
    rows: Record<string, DashboardAiQueryCell>[];
    rowCount: number;
    truncated: boolean;
    executedSqlPreview: string;
    dataQualityNotes: string[];
  }
): DashboardAiSqlQueryResult {
  return {
    queryId: plan.queryId,
    view: 'flight_operations',
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
    executedSqlPreview: result.executedSqlPreview,
    dataQualityNotes: [
      `generated_sql: ${plan.reasonVi}`,
      'validated_sql: SQL đã qua gateway SELECT read-only.',
      'executed_local_sql: Đã chạy trên SQLite local.',
      ...result.dataQualityNotes,
    ].slice(0, 8),
  };
}

function inferDashboardAiExplicitSeasonIds(normalizedPrompt: string, catalog: DashboardAiDataScopeSeason[]): string[] {
  const requestedCodes = new Set(Array.from(normalizedPrompt.matchAll(/\b([sw]\d{2})\b/g)).map((match) => match[1].toUpperCase()));
  if (requestedCodes.size === 0) return [];
  return catalog
    .filter((season) => requestedCodes.has(season.seasonCode.toUpperCase()))
    .map((season) => season.seasonId);
}

function inferDashboardAiScopeDateRange(normalizedPrompt: string): { from: string; to: string } | null {
  const dates = Array.from(normalizedPrompt.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((match) => match[1]);
  if (dates.length < 2) return null;
  const [first, second] = dates;
  if (!first || !second) return null;
  return first <= second ? { from: first, to: second } : { from: second, to: first };
}

function inferDashboardAiScopeMonths(
  normalizedPrompt: string,
  catalog: DashboardAiDataScopeSeason[],
  scopedCatalog: DashboardAiDataScopeSeason[]
): string[] {
  const months: string[] = [];
  for (const match of normalizedPrompt.matchAll(/\b(20\d{2})-(1[0-2]|0[1-9])\b/g)) {
    months.push(`${match[1]}-${match[2]}`);
  }
  for (const match of normalizedPrompt.matchAll(/\b(?:thang|month)\s*(1[0-2]|0?[1-9])\/(20\d{2})\b/g)) {
    months.push(`${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  }
  for (const match of normalizedPrompt.matchAll(/\b(1[0-2]|0?[1-9])\/(20\d{2})\b/g)) {
    months.push(`${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  }
  if (months.length > 0) return normalizeDashboardAiMonthKeys(months);

  const monthOnlyMatches = Array.from(normalizedPrompt.matchAll(/\b(?:thang|month)\s*(1[0-2]|0?[1-9])\b/g));
  for (const match of monthOnlyMatches) {
    const month = Number(match[1]);
    const resolved = resolveDashboardAiMonthWithoutYear(month, scopedCatalog.length > 0 ? scopedCatalog : catalog) ??
      resolveDashboardAiMonthWithoutYear(month, catalog);
    if (resolved) months.push(resolved);
  }
  return normalizeDashboardAiMonthKeys(months);
}

function resolveDashboardAiMonthWithoutYear(month: number, catalog: DashboardAiDataScopeSeason[]): string | null {
  const monthText = String(month).padStart(2, '0');
  const candidates = new Set<string>();
  for (const season of catalog) {
    const startYear = Number((season.dateRange.from || '').slice(0, 4));
    const endYear = Number((season.dateRange.to || '').slice(0, 4));
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) continue;
    for (let year = startYear; year <= endYear; year += 1) {
      const monthKey = `${year}-${monthText}`;
      const range = dashboardAiMonthRange(monthKey);
      if (range && dashboardAiRangeOverlaps(season.dateRange.from, season.dateRange.to, range.from, range.to)) {
        candidates.add(monthKey);
      }
    }
  }
  return Array.from(candidates).sort().at(-1) ?? null;
}

function isDashboardAiYoyScopePrompt(normalizedPrompt: string): boolean {
  return /\b(yoy|year over year|same period|cung ky|nam truoc|so voi nam truoc|previous year|last year)\b/.test(normalizedPrompt);
}

function normalizeDashboardAiMonthKeys(months: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const month of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || seen.has(month)) continue;
    seen.add(month);
    normalized.push(month);
  }
  return normalized;
}

function shiftDashboardAiMonthKeyYear(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split('-');
  return `${Number(year) + offset}-${month}`;
}

function resolveDashboardAiSeasonIdsForMonths(
  catalog: DashboardAiDataScopeSeason[],
  months: string[],
  fallbackSeasonIds: string[],
  activeSeasonId: string | null
): string[] {
  const ranges = months.map(dashboardAiMonthRange).filter((range): range is { from: string; to: string } => Boolean(range));
  const seasonIds = catalog
    .filter((season) => ranges.some((range) => dashboardAiRangeOverlaps(season.dateRange.from, season.dateRange.to, range.from, range.to)))
    .map((season) => season.seasonId);
  return normalizeDashboardAiScopeSeasonIds(seasonIds.length > 0 ? seasonIds : fallbackSeasonIds.length > 0 ? fallbackSeasonIds : activeSeasonId ? [activeSeasonId] : [], catalog);
}

function resolveDashboardAiSeasonIdsForRange(
  catalog: DashboardAiDataScopeSeason[],
  from: string,
  to: string,
  fallbackSeasonIds: string[],
  activeSeasonId: string | null
): string[] {
  const seasonIds = catalog
    .filter((season) => dashboardAiRangeOverlaps(season.dateRange.from, season.dateRange.to, from, to))
    .map((season) => season.seasonId);
  return normalizeDashboardAiScopeSeasonIds(seasonIds.length > 0 ? seasonIds : fallbackSeasonIds.length > 0 ? fallbackSeasonIds : activeSeasonId ? [activeSeasonId] : [], catalog);
}

function dashboardAiMonthRange(monthKey: string): { from: string; to: string } | null {
  const match = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${match[1]}-${match[2]}-01`,
    to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`,
  };
}

function dashboardAiRangeOverlaps(leftFrom: string, leftTo: string, rightFrom: string, rightTo: string): boolean {
  if (!leftFrom || !leftTo || !rightFrom || !rightTo) return false;
  return leftFrom <= rightTo && leftTo >= rightFrom;
}

function normalizeDashboardAiScopeSeasonIds(ids: string[], catalog: DashboardAiDataScopeSeason[]): string[] {
  const requested = new Set(ids.filter(Boolean));
  const ordered = catalog.filter((season) => requested.has(season.seasonId)).map((season) => season.seasonId);
  const extras = ids.filter((id) => id && !ordered.includes(id));
  return Array.from(new Set([...ordered, ...extras]));
}

function inferSingleDashboardAiSqlMonth(prompt: string, context?: unknown): string | null {
  const normalized = normalizePromptForToolRouting(prompt);
  const explicit = /\b(20\d{2})-(1[0-2]|0[1-9])\b/.exec(normalized);
  if (explicit) return `${explicit[1]}-${explicit[2]}`;
  const slash = /\b(1[0-2]|0?[1-9])\/(20\d{2})\b/.exec(normalized);
  if (slash) return `${slash[2]}-${String(Number(slash[1])).padStart(2, '0')}`;
  const month = /\bthang\s*(1[0-2]|0?[1-9])(?:\/(20\d{2}))?\b/.exec(normalized);
  if (!month) return inferDashboardAiSqlFirstScopedMonth(context);
  const scopedMonth = inferDashboardAiSqlScopedMonth(Number(month[1]), context);
  if (scopedMonth) return scopedMonth;
  const year = month[2] ?? inferDashboardAiSqlContextYear(context);
  return `${year}-${String(Number(month[1])).padStart(2, '0')}`;
}

function inferDashboardAiSqlMonthPair(prompt: string, context?: unknown): { current: string; previous: string } | null {
  const normalized = normalizePromptForToolRouting(prompt);
  const explicit = Array.from(normalized.matchAll(/\b(20\d{2})-(1[0-2]|0[1-9])\b/g))
    .map((match) => `${match[1]}-${match[2]}`);
  if (explicit.length >= 2) return { current: explicit[0], previous: explicit[1] };
  const slash = Array.from(normalized.matchAll(/\b(1[0-2]|0?[1-9])\/(20\d{2})\b/g))
    .filter((match) => match.index == null || normalized[Math.max(0, match.index - 1)] !== '/')
    .map((match) => `${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  if (slash.length >= 2) return { current: slash[0], previous: slash[1] };
  const monthMatches = Array.from(normalized.matchAll(/\b(?:thang|month)\s*(1[0-2]|0?[1-9])(?:\/(20\d{2}))?\b/g))
    .map((match) => ({
      month: Number(match[1]),
      year: match[2] ?? inferDashboardAiSqlContextYear(context),
    }));
  const monthKeys = normalizeDashboardAiMonthKeys(monthMatches.map((match) => (
    `${match.year}-${String(match.month).padStart(2, '0')}`
  )));
  if (monthKeys.length >= 2) {
    return {
      current: monthKeys[0],
      previous: monthKeys[1],
    };
  }
  return null;
}

function inferDashboardAiComparisonDimension(normalizedPrompt: string): 'airline' | 'route' | 'country' | 'aircraft' | 'type' | 'local_hour' {
  if (/\b(route|duong bay)\b/.test(normalizedPrompt)) return 'route';
  if (/\b(country|quoc gia)\b/.test(normalizedPrompt)) return 'country';
  if (/\b(aircraft|may bay|tau bay)\b/.test(normalizedPrompt)) return 'aircraft';
  if (/\b(arr\/dep|arr dep|arrival|departure|type)\b/.test(normalizedPrompt)) return 'type';
  if (/\b(hour|gio|khung gio|peak hour)\b/.test(normalizedPrompt)) return 'local_hour';
  return 'airline';
}

function inferDashboardAiSqlFirstScopedMonth(context?: unknown): string | null {
  const dataScope = typeof context === 'object' && context != null && 'dataScope' in context
    ? (context as { dataScope?: DashboardAiResolvedDataScope | null }).dataScope
    : null;
  return dataScope?.months?.[0] ?? null;
}

function inferDashboardAiSqlScopedMonth(month: number, context?: unknown): string | null {
  const dataScope = typeof context === 'object' && context != null && 'dataScope' in context
    ? (context as { dataScope?: DashboardAiResolvedDataScope | null }).dataScope
    : null;
  const monthText = String(month).padStart(2, '0');
  return dataScope?.months?.find((monthKey) => monthKey.endsWith(`-${monthText}`)) ?? null;
}

function inferDashboardAiSqlContextYear(context?: unknown): string {
  const text = JSON.stringify(context ?? {});
  const match = /\b20\d{2}\b/.exec(text);
  return match?.[0] ?? new Date().getFullYear().toString();
}

export function resolveDashboardAiLocalQueryResults(
  queries: DashboardAiDataQuery[],
  input: DashboardAiLocalQueryInput
): DashboardAiQueryResult[] {
  return queries.slice(0, DASHBOARD_AI_MAX_ROUNDS)
    .map((query) => resolveDashboardAiLocalQueryResult(query, input))
    .filter((result): result is DashboardAiQueryResult => Boolean(result));
}

function resolveDashboardAiLocalQueryResult(
  query: DashboardAiDataQuery,
  input: DashboardAiLocalQueryInput
): DashboardAiQueryResult | null {
  const sourceRows = input.seasonRows.flatMap((season) => season.records.map((record) => ({
    season,
    record,
  })));
  const filteredRows = sourceRows.filter(({ season, record }) => localAiRecordMatchesQuery(record, season, query, input.routeCountries));
  const orderedMetrics: DashboardAiQueryMetric[] = query.metrics.length > 0 ? query.metrics : ['flights'];
  const limit = Math.min(Math.max(1, query.limit || 24), 500);
  const resultRows = query.groupBy.length > 0
    ? buildLocalAiGroupedRows(filteredRows, query.groupBy, orderedMetrics, input.routeCountries)
    : buildLocalAiDetailRows(filteredRows, query, input.routeCountries);
  const orderedRows = orderLocalAiQueryRows(resultRows, query.orderBy, orderedMetrics[0]).slice(0, limit);
  const columns = orderedRows.length > 0
    ? Object.keys(orderedRows[0])
    : query.groupBy.length > 0 ? query.groupBy.concat(orderedMetrics) : localAiDefaultDetailColumns(query);
  const pendingCount = input.seasonRows.reduce((sum, season) => sum + (season.pendingCount ?? 0), 0);
  const anyTruncated = input.seasonRows.some((season) => season.truncated === true);
  const allLocal = input.seasonRows.every((season) => season.dataSource == null || season.dataSource === 'active' || season.dataSource === 'local');
  const sourceNote = allLocal
    ? pendingCount > 0
      ? 'Nguồn: SQLite local, bao gồm thay đổi chưa đồng bộ.'
      : 'Nguồn: SQLite local.'
    : 'Nguồn: dữ liệu đã tải trong AI Workspace, có thể trộn local/cache/server.';
  return {
    queryId: query.queryId,
    view: query.view,
    columns,
    rows: orderedRows,
    rowCount: resultRows.length,
    truncated: resultRows.length > limit,
    dataQualityNotes: [
      sourceNote,
      ...(anyTruncated ? ['Dữ liệu local đang dùng cửa sổ đọc bị giới hạn; một số dòng ngoài cửa sổ có thể chưa có trong kết quả.'] : []),
      `Đã lọc ${filteredRows.length.toLocaleString('en-US')} chuyến bay từ ${input.seasonRows.length.toLocaleString('en-US')} mùa theo queryId=${query.queryId}.`,
    ],
  };
}

function localAiRecordMatchesQuery(
  record: FlightRecord,
  season: DashboardAiLocalQuerySeason,
  query: DashboardAiDataQuery,
  routeCountries?: RouteCountryMapping[] | null
): boolean {
  if (record.status === 'deleted') return false;
  const filters = query.filters;
  const operationalDate = getDashboardOperationalDate(record);
  if (filters.seasonIds?.length && !filters.seasonIds.includes(season.seasonId)) return false;
  if (filters.iataSeasonCodes?.length) {
    const codes = new Set(filters.iataSeasonCodes.map((code) => code.toUpperCase()));
    const recordSeasonCode = (record.iataSeasonCode ?? season.seasonCode).toUpperCase();
    if (!codes.has(recordSeasonCode) && !codes.has(season.seasonCode.toUpperCase())) return false;
  }
  if (filters.dateFrom && operationalDate < filters.dateFrom) return false;
  if (filters.dateTo && operationalDate > filters.dateTo) return false;
  if (filters.months?.length && !filters.months.includes(operationalDate.slice(0, 7))) return false;
  if (filters.weeks?.length && !filters.weeks.includes(localAiIsoWeekKey(operationalDate))) return false;
  if (filters.typeFilter && filters.typeFilter !== 'all' && record.type !== filters.typeFilter) return false;
  if (filters.airlines?.length && !filters.airlines.map((value) => value.toUpperCase()).includes((record.airline ?? '').toUpperCase())) return false;
  if (filters.routes?.length && !filters.routes.map((value) => value.toUpperCase()).includes((record.route ?? '').toUpperCase())) return false;
  if (filters.countries?.length) {
    const country = resolveCountryForRoute(record.route, routeCountries ?? undefined);
    if (!filters.countries.includes(country)) return false;
  }
  if (filters.aircraft?.length && !filters.aircraft.map((value) => value.toUpperCase()).includes((record.aircraft ?? '').toUpperCase())) return false;
  const hour = localAiRecordHour(record);
  if (filters.localHourFrom != null && (hour == null || hour < filters.localHourFrom)) return false;
  if (filters.localHourTo != null && (hour == null || hour >= filters.localHourTo)) return false;
  return true;
}

function buildLocalAiGroupedRows(
  rows: Array<{ season: DashboardAiLocalQuerySeason; record: FlightRecord }>,
  groupBy: string[],
  metrics: DashboardAiQueryMetric[],
  routeCountries?: RouteCountryMapping[] | null
): Record<string, DashboardAiQueryCell>[] {
  const groups = new Map<string, {
    labels: Record<string, DashboardAiQueryCell>;
    records: FlightRecord[];
  }>();
  for (const row of rows) {
    const labels = Object.fromEntries(groupBy.map((column) => [column, localAiColumnValue(row.record, row.season, column, routeCountries)]));
    const key = groupBy.map((column) => String(labels[column] ?? 'Unknown')).join('\u001f');
    const current = groups.get(key) ?? { labels, records: [] };
    current.records.push(row.record);
    groups.set(key, current);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group.labels,
    ...Object.fromEntries(metrics.map((metric) => [metric, localAiMetricValue(group.records, metric)])),
  }));
}

function buildLocalAiDetailRows(
  rows: Array<{ season: DashboardAiLocalQuerySeason; record: FlightRecord }>,
  query: DashboardAiDataQuery,
  routeCountries?: RouteCountryMapping[] | null
): Record<string, DashboardAiQueryCell>[] {
  const columns = localAiDefaultDetailColumns(query);
  return rows.map(({ season, record }) => Object.fromEntries(
    columns.map((column) => [column, localAiColumnValue(record, season, column, routeCountries)])
  ));
}

function localAiDefaultDetailColumns(query: DashboardAiDataQuery): string[] {
  if (query.view !== 'flight_operations') {
    return ['season_id', 'season', 'type', ...query.metrics];
  }
  return ['season_id', 'season', 'record_id', 'type', 'flight', 'airline', 'route', 'country', 'aircraft', 'pax', 'ops_date', 'month', 'iso_week', 'local_hour', 'status', 'gate'];
}

function localAiColumnValue(
  record: FlightRecord,
  season: DashboardAiLocalQuerySeason,
  column: string,
  routeCountries?: RouteCountryMapping[] | null
): DashboardAiQueryCell {
  const operationalDate = getDashboardOperationalDate(record);
  if (column === 'season_id') return season.seasonId;
  if (column === 'season' || column === 'season_code' || column === 'iata_season_code') return record.iataSeasonCode ?? season.seasonCode;
  if (column === 'record_id') return record.id;
  if (column === 'type') return record.type;
  if (column === 'flight') return record.flightNumber || record.rawFlightNumber || '';
  if (column === 'airline') return record.airline || 'Unknown';
  if (column === 'route') return record.route || 'Unknown';
  if (column === 'country') return resolveCountryForRoute(record.route, routeCountries ?? undefined);
  if (column === 'aircraft') return record.aircraft || 'Unknown';
  if (column === 'pax') return localAiRecordPax(record);
  if (column === 'scheduled_date') return record.scheduledDate ?? record.date;
  if (column === 'scheduled_time') return record.scheduledTime ?? record.schedule;
  if (column === 'ops_date') return operationalDate;
  if (column === 'month') return operationalDate.slice(0, 7);
  if (column === 'iso_week') return localAiIsoWeekKey(operationalDate);
  if (column === 'local_hour') return localAiRecordHour(record);
  if (column === 'weekday') return localAiWeekday(operationalDate);
  if (column === 'status') return record.status;
  if (column === 'gate') return record.gate;
  if (column === 'stand') return record.stand;
  if (column === 'carousel') return record.carousel;
  if (column === 'flights') return 1;
  if (column === 'arrivals') return record.type === 'A' ? 1 : 0;
  if (column === 'departures') return record.type === 'D' ? 1 : 0;
  return null;
}

function localAiMetricValue(records: FlightRecord[], metric: DashboardAiQueryMetric): number {
  if (metric === 'flights') return records.length;
  if (metric === 'pax') return records.reduce((sum, record) => sum + localAiRecordPax(record), 0);
  if (metric === 'arrivals') return records.filter((record) => record.type === 'A').length;
  if (metric === 'departures') return records.filter((record) => record.type === 'D').length;
  return 0;
}

function localAiRecordPax(record: FlightRecord): number {
  return Number.isFinite(record.pax ?? NaN) ? Number(record.pax) : 0;
}

function localAiRecordHour(record: FlightRecord): number | null {
  const raw = record.scheduledTime ?? record.schedule;
  const match = /^(\d{1,2})/.exec(raw ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function localAiWeekday(date: string): number | null {
  const parsed = localAiParseIsoDate(date);
  return parsed ? parsed.getUTCDay() : null;
}

function localAiIsoWeekKey(date: string): string {
  const parsed = localAiParseIsoDate(date);
  if (!parsed) return '';
  const target = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const weekYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function localAiParseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function orderLocalAiQueryRows(
  rows: Record<string, DashboardAiQueryCell>[],
  orderBy: string | undefined,
  fallbackMetric: DashboardAiQueryMetric
): Record<string, DashboardAiQueryCell>[] {
  const key = orderBy || fallbackMetric;
  return [...rows].sort((left, right) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
      return (Number(rightValue) || 0) - (Number(leftValue) || 0);
    }
    return String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
  });
}

export function buildDashboardAiFallbackBoardPatch(input: {
  userPrompt: string;
  preferredTool?: DashboardAiToolName | null;
  visualReport?: DashboardVisualReportSpec | null;
}): DashboardAiBoardPatch | null {
  if (input.visualReport) {
    const visualPatch = buildDashboardAiBoardPatchFromVisualReport(input.visualReport);
    if (visualPatch) return visualPatch;
  }
  const isBoardIntent = input.preferredTool === 'compose_dashboard_ai_board' || resolveDashboardAiWorkspaceToolForPrompt(input.userPrompt) === 'compose_dashboard_ai_board';
  if (!isBoardIntent) return null;
  return buildDashboardAiDefaultBoardPatch(input.userPrompt);
}

export function resolveDashboardAiToolTraceSummary(value: unknown): DashboardAiToolTraceSummary[] {
  if (!Array.isArray(value)) return [];
  const allowedTools = new Set(DASHBOARD_AI_TOOL_REGISTRY.map((tool) => tool.name)); 
  const allowedStatuses = new Set<DashboardAiToolTraceStatus>(['accepted', 'rejected', 'executed', 'skipped']); 
  const allowedPhases = new Set<DashboardAiToolTracePhase>(['generated_sql', 'validated_sql', 'executed_local_sql', 'profiled_query_result', 'verified_answer', 'rendered_rich_chat', 'rendered_sandbox_html', 'rejected_unsafe_render']); 
  const allowedContextProfiles = new Set<DashboardAiContextProfile>(['overview', 'comparison-drivers', 'peak-hour', 'route-country', 'airline-mix', 'season-overview', 'multi-season', 'validated-sql', 'eda-profile', 'data-quality', 'visualization', 'answer-verification', 'safe-rendering']); 
  const traces: DashboardAiToolTraceSummary[] = []; 
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.tool !== 'string' || !allowedTools.has(raw.tool as DashboardAiToolName)) continue;
    const status = typeof raw.status === 'string' && allowedStatuses.has(raw.status as DashboardAiToolTraceStatus)
      ? raw.status as DashboardAiToolTraceStatus
      : 'accepted';
    traces.push({
      tool: raw.tool as DashboardAiToolName, 
      status, 
      reason: sanitizeVisualText(raw.reason, '', 160), 
      ...(typeof raw.phase === 'string' && allowedPhases.has(raw.phase as DashboardAiToolTracePhase) 
        ? { phase: raw.phase as DashboardAiToolTracePhase } 
        : {}), 
      ...(typeof raw.skill === 'string' ? { skill: sanitizeVisualText(raw.skill, '', 80) } : {}), 
      ...(typeof raw.toolset === 'string' && ['dashboard-readonly', 'dashboard-visual', 'dashboard-export', 'dashboard-memory'].includes(raw.toolset)
        ? { toolset: raw.toolset as DashboardAiToolset }
        : {}),
      ...(typeof raw.fallbackReason === 'string' ? { fallbackReason: sanitizeVisualText(raw.fallbackReason, '', 160) } : {}),
      ...(typeof raw.contextProfile === 'string' && allowedContextProfiles.has(raw.contextProfile as DashboardAiContextProfile) 
        ? { contextProfile: raw.contextProfile as DashboardAiContextProfile } 
        : {}), 
      ...(typeof raw.providerAttempt === 'number' && Number.isFinite(raw.providerAttempt) && raw.providerAttempt > 0
        ? { providerAttempt: Math.min(4, Math.floor(raw.providerAttempt)) }
        : {}),
    });
  }
  return traces;
}

export function createDashboardAiRunEvent(
  runId: string,
  type: DashboardAiRunEventType,
  input: Partial<Omit<DashboardAiRunEvent, 'id' | 'runId' | 'type' | 'createdAt'>> = {}
): DashboardAiRunEvent {
  const createdAt = Date.now();
  return {
    id: `${runId}-${type}-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    runId,
    type,
    createdAt,
    ...input,
  };
}

function resolveDashboardAiRunToolName(value: unknown): DashboardAiToolName | undefined {
  if (typeof value !== 'string') return undefined;
  return DASHBOARD_AI_TOOL_REGISTRY.some((tool) => tool.name === value) ? value as DashboardAiToolName : undefined;
}

function summarizeSkawldInput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return sanitizeDisplayText(JSON.stringify(value), '', 280);
  } catch {
    return undefined;
  }
}

function extractSkawldTextBlockText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const raw = block as { type?: unknown; text?: unknown };
      return raw.type === 'text' && typeof raw.text === 'string' ? raw.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mapSkawldEventToDashboardAiRunEvent(
  event: unknown,
  options: { runId?: string; now?: number } = {}
): DashboardAiRunEvent | null {
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') return null;
  const raw = event as Record<string, unknown>;
  const rawType = String(raw.type);
  const runId = typeof raw.run_id === 'string'
    ? raw.run_id
    : typeof raw.subagent_run_id === 'string'
      ? raw.subagent_run_id
      : options.runId ?? `skawld-run-${options.now ?? Date.now()}`;
  const metadataBase: Record<string, string | number | boolean | null> = { skawldType: rawType };
  const makeEvent = (
    type: DashboardAiRunEventType,
    input: Partial<Omit<DashboardAiRunEvent, 'id' | 'runId' | 'type' | 'createdAt'>> = {}
  ) => createDashboardAiRunEvent(runId, type, input);

  if (rawType === 'system' && raw.subtype === 'init') {
    return makeEvent('init', {
      message: 'Khởi tạo Skawld runtime spike.',
      metadata: {
        ...metadataBase,
        sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        permissionMode: typeof raw.permission_mode === 'string' ? raw.permission_mode : null,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        tools: Array.isArray(raw.tools) ? raw.tools.join(',') : null,
      },
    });
  }
  if (rawType === 'user') {
    const prompt = extractSkawldTextBlockText(raw.message);
    return makeEvent('user', {
      prompt,
      message: prompt,
      metadata: metadataBase,
    });
  }
  if (rawType === 'assistant') {
    return makeEvent('partial_assistant', {
      message: extractSkawldTextBlockText(raw.message),
      metadata: {
        ...metadataBase,
        stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : null,
      },
    });
  }
  if (rawType === 'partial_assistant') {
    const delta = raw.delta && typeof raw.delta === 'object' ? raw.delta as { text?: unknown; kind?: unknown } : null;
    return makeEvent('partial_assistant', {
      message: typeof delta?.text === 'string' ? delta.text : '',
      metadata: {
        ...metadataBase,
        deltaKind: typeof delta?.kind === 'string' ? delta.kind : null,
      },
    });
  }
  if (rawType === 'tool_call_start') {
    const toolName = resolveDashboardAiRunToolName(raw.tool_name);
    return makeEvent('tool_call_start', {
      tool: toolName,
      status: 'started',
      reason: toolName ? `Skawld bắt đầu chạy tool ${toolName}.` : 'Skawld bắt đầu chạy tool ngoài registry Dashboard AI.',
      inputSummary: summarizeSkawldInput(raw.input),
      metadata: {
        ...metadataBase,
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null,
        rawToolName: typeof raw.tool_name === 'string' ? raw.tool_name : null,
      },
    });
  }
  if (rawType === 'tool_call_end') {
    const toolName = resolveDashboardAiRunToolName(raw.tool_name);
    const failed = raw.is_error === true;
    return makeEvent('tool_call_end', {
      tool: toolName,
      status: failed ? 'failed' : 'completed',
      reason: failed
        ? `Skawld tool ${typeof raw.tool_name === 'string' ? raw.tool_name : 'unknown'} trả lỗi.`
        : `Skawld tool ${typeof raw.tool_name === 'string' ? raw.tool_name : 'unknown'} hoàn tất.`,
      durationMs: typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms) ? Math.max(0, Math.floor(raw.duration_ms)) : undefined,
      metadata: {
        ...metadataBase,
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null,
        rawToolName: typeof raw.tool_name === 'string' ? raw.tool_name : null,
      },
    });
  }
  if (rawType === 'permission_request') {
    const requests = Array.isArray(raw.requests) ? raw.requests : [];
    const firstRequest = requests.find((entry) => Boolean(entry && typeof entry === 'object')) as Record<string, unknown> | undefined;
    const toolName = resolveDashboardAiRunToolName(firstRequest?.tool_name);
    return makeEvent('permission_request', {
      tool: toolName,
      status: 'started',
      reason: typeof firstRequest?.summary === 'string'
        ? sanitizeDisplayText(firstRequest.summary, '', 180)
        : 'Skawld yêu cầu xác nhận quyền tool.',
      metadata: {
        ...metadataBase,
        requestCount: requests.length,
        rawToolName: typeof firstRequest?.tool_name === 'string' ? firstRequest.tool_name : null,
      },
    });
  }
  if (rawType === 'usage') {
    const usage = raw.cumulative && typeof raw.cumulative === 'object' ? raw.cumulative as Record<string, unknown> : raw.usage as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
    const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
    return makeEvent('usage', {
      usage: {
        ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
        ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
        ...(typeof inputTokens === 'number' || typeof outputTokens === 'number' ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) } : {}),
      },
      metadata: metadataBase,
    });
  }
  if (rawType === 'compaction') {
    return makeEvent('compaction', {
      reason: typeof raw.strategy === 'string' ? `Skawld compact context bằng ${raw.strategy}.` : 'Skawld compact context.',
      metadata: {
        ...metadataBase,
        messagesBefore: typeof raw.messages_before === 'number' ? raw.messages_before : null,
        messagesAfter: typeof raw.messages_after === 'number' ? raw.messages_after : null,
        tokensBefore: typeof raw.tokens_before === 'number' ? raw.tokens_before : null,
        tokensAfter: typeof raw.tokens_after === 'number' ? raw.tokens_after : null,
      },
    });
  }
  if (rawType === 'result') {
    const totalUsage = raw.total_usage && typeof raw.total_usage === 'object' ? raw.total_usage as Record<string, unknown> : {};
    const inputTokens = typeof totalUsage.input_tokens === 'number' ? totalUsage.input_tokens : undefined;
    const outputTokens = typeof totalUsage.output_tokens === 'number' ? totalUsage.output_tokens : undefined;
    return makeEvent('result', {
      message: typeof raw.final_text === 'string' ? raw.final_text : '',
      status: raw.subtype === 'error' ? 'failed' : 'completed',
      durationMs: typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms) ? Math.max(0, Math.floor(raw.duration_ms)) : undefined,
      usage: {
        ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
        ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
        ...(typeof inputTokens === 'number' || typeof outputTokens === 'number' ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) } : {}),
      },
      metadata: {
        ...metadataBase,
        subtype: typeof raw.subtype === 'string' ? raw.subtype : null,
        stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : null,
      },
    });
  }
  if (rawType === 'error') {
    const error = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : {};
    return makeEvent('error', {
      status: 'failed',
      error: typeof error.message === 'string' ? error.message : 'Skawld runtime trả lỗi không xác định.',
      metadata: {
        ...metadataBase,
        name: typeof error.name === 'string' ? error.name : null,
        retryable: typeof error.retryable === 'boolean' ? error.retryable : null,
      },
    });
  }
  if (rawType === 'skill_invoked') {
    return makeEvent('skill_invoked', {
      skill: typeof raw.name === 'string' ? raw.name : undefined,
      reason: typeof raw.name === 'string' ? `Skawld gọi skill ${raw.name}.` : 'Skawld gọi skill.',
      metadata: metadataBase,
    });
  }
  if (rawType === 'skill_completed') {
    return makeEvent('skill_completed', {
      skill: typeof raw.name === 'string' ? raw.name : undefined,
      status: raw.is_error === true ? 'failed' : 'completed',
      reason: typeof raw.name === 'string' ? `Skawld hoàn tất skill ${raw.name}.` : 'Skawld hoàn tất skill.',
      metadata: metadataBase,
    });
  }
  if (rawType === 'subagent_event' && raw.event) {
    const mapped = mapSkawldEventToDashboardAiRunEvent(raw.event, {
      runId,
      now: options.now,
    });
    if (!mapped) return null;
    return {
      ...mapped,
      metadata: {
        ...(mapped.metadata ?? {}),
        parentSessionId: typeof raw.parent_session_id === 'string' ? raw.parent_session_id : null,
        subagentRunId: typeof raw.subagent_run_id === 'string' ? raw.subagent_run_id : null,
        subagentType: typeof raw.subagent_type === 'string' ? raw.subagent_type : null,
        subagentDisplayName: typeof raw.display_name === 'string' ? raw.display_name : null,
      },
    };
  }
  return null;
}

export function appendDashboardAiRunEvent(
  events: DashboardAiRunEvent[] | null | undefined,
  event: DashboardAiRunEvent,
  options: { maxEvents?: number } = {}
): DashboardAiRunEvent[] {
  const maxEvents = Math.max(1, options.maxEvents ?? 120);
  return [...(events ?? []), event].slice(-maxEvents);
}

export function compactDashboardAiSessionLedger(
  events: DashboardAiRunEvent[] | null | undefined,
  options: { maxProviderEvents?: number; maxSummaryEvents?: number } = {}
): DashboardAiSessionLedger {
  const sourceEvents = (events ?? []).filter((event): event is DashboardAiRunEvent => Boolean(event && typeof event === 'object'));
  const maxProviderEvents = Math.max(1, options.maxProviderEvents ?? 24);
  const maxSummaryEvents = Math.max(1, options.maxSummaryEvents ?? 12);
  const providerView = sourceEvents.slice(-maxProviderEvents);
  const summaryEvents = sourceEvents.slice(0, Math.max(0, sourceEvents.length - maxProviderEvents)).slice(-maxSummaryEvents);
  const summaryVi = summaryEvents.length > 0
    ? summaryEvents
        .map((event) => {
          const label = event.tool ? `${event.type}:${event.tool}` : event.type;
          const text = event.message ?? event.reason ?? event.outputSummary ?? event.error ?? event.prompt ?? '';
          return `${label}${text ? ` - ${sanitizeDisplayText(text, '', 120)}` : ''}`;
        })
        .join('\n')
    : undefined;
  return {
    runId: providerView.at(-1)?.runId ?? sourceEvents.at(-1)?.runId ?? `ai-run-${Date.now()}`,
    events: sourceEvents,
    providerView,
    fullEventCount: sourceEvents.length,
    compacted: sourceEvents.length > providerView.length,
    ...(summaryVi ? { summaryVi } : {}),
  };
}

export function buildDashboardAiSessionLedger(
  cells: DashboardAiNotebookCell[] | null | undefined,
  options: { activeCellId?: string | null; maxProviderEvents?: number } = {}
): DashboardAiSessionLedger {
  const events: DashboardAiRunEvent[] = [];
  for (const [index, cell] of (cells ?? []).entries()) {
    const runId = cell.id || `ai-cell-${index + 1}`;
    if (cell.runEvents?.length) {
      events.push(...cell.runEvents);
      continue;
    }
    events.push(createDashboardAiRunEvent(runId, 'user', {
      prompt: cell.prompt,
      metadata: { cellId: cell.id, cellIndex: index + 1 },
    }));
    for (const trace of cell.toolTraceSummary ?? []) {
      events.push(createDashboardAiRunEvent(runId, 'tool_call_end', {
        tool: trace.tool,
        toolset: trace.toolset,
        status: trace.status,
        reason: trace.reason,
        skill: trace.skill,
        metadata: {
          cellId: cell.id,
          phase: trace.phase ?? null,
          providerAttempt: trace.providerAttempt ?? null,
        },
      }));
    }
    events.push(createDashboardAiRunEvent(runId, 'result', {
      message: cell.assistantText,
      status: 'completed',
      metadata: {
        cellId: cell.id,
        blockCount: cell.blocks.length,
        active: options.activeCellId ? cell.id === options.activeCellId : false,
      },
    }));
  }
  return compactDashboardAiSessionLedger(events, { maxProviderEvents: options.maxProviderEvents });
}

export function evaluateDashboardAiToolPermission(input: DashboardAiToolPermissionInput): DashboardAiToolPermissionDecision {
  const allowedTools = new Set(input.allowedTools);
  const availableTool = (input.availableTools ?? DASHBOARD_AI_TOOL_REGISTRY).find((tool) => tool.name === input.tool);
  const readOnlyTools = new Set<DashboardAiToolName>(['query_dashboard_data', 'suggest_visual_report', 'compose_dashboard_ai_board']);
  const readOnly = input.readOnly ?? readOnlyTools.has(input.tool);
  const requiresConfirmation = input.requiresConfirmation ?? (!readOnly || input.tool === 'suggest_custom_workbook');
  if (!allowedTools.has(input.tool)) {
    return {
      decision: 'deny',
      reasonVi: `Tool ${input.tool} không nằm trong allowedTools của lượt chạy AI.`,
      readOnly,
      requiresConfirmation,
    };
  }
  if (!availableTool || availableTool.availability === 'disabled') {
    return {
      decision: 'deny',
      reasonVi: availableTool?.disabledReason ?? `Tool ${input.tool} chưa khả dụng trong trạng thái dashboard hiện tại.`,
      readOnly,
      requiresConfirmation,
    };
  }
  if (!readOnly && requiresConfirmation) {
    return {
      decision: 'ask',
      reasonVi: `Tool ${input.tool} cần xác nhận trước khi thực hiện hành động không read-only.`,
      readOnly,
      requiresConfirmation,
    };
  }
  const updatedInput = sanitizeDashboardAiPermissionInput(input.tool, input.input ?? {});
  return {
    decision: 'allow',
    reasonVi: readOnly
      ? `Cho phép ${input.tool}: read-only và nằm trong allowedTools.`
      : `Cho phép ${input.tool}: đã qua kiểm tra quyền.`,
    readOnly,
    requiresConfirmation,
    updatedInput,
  };
}

export function scheduleDashboardAiRun(
  calls: DashboardAiToolScheduleItem[],
  input: { allowedTools: DashboardAiToolName[]; availableTools?: DashboardAiToolDefinition[]; readOnly?: boolean }
): DashboardAiToolScheduleResult {
  const serial: DashboardAiToolScheduleItem[] = [];
  const parallelBatches: DashboardAiToolScheduleItem[][] = [];
  const rejected: DashboardAiToolScheduleResult['rejected'] = [];
  let currentParallelBatch: DashboardAiToolScheduleItem[] = [];
  const flushParallel = () => {
    if (currentParallelBatch.length > 0) {
      parallelBatches.push(currentParallelBatch);
      currentParallelBatch = [];
    }
  };
  for (const call of calls) {
    const decision = evaluateDashboardAiToolPermission({
      tool: call.tool,
      allowedTools: input.allowedTools,
      availableTools: input.availableTools,
      readOnly: input.readOnly,
      input: call.input,
    });
    if (decision.decision !== 'allow') {
      flushParallel();
      rejected.push({ item: call, reasonVi: decision.reasonVi });
      continue;
    }
    const scheduled = decision.updatedInput ? { ...call, input: decision.updatedInput } : call;
    if (scheduled.parallelSafe) {
      currentParallelBatch.push(scheduled);
    } else {
      flushParallel();
      serial.push(scheduled);
    }
  }
  flushParallel();
  return { serial, parallelBatches, rejected };
}

function sanitizeDashboardAiPermissionInput(
  tool: DashboardAiToolName,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (tool === 'query_dashboard_data') {
    const limit = optionalPositiveInteger(input.limit ?? input.maxRecords, 500);
    return {
      ...input,
      limit: limit === false ? 500 : Math.min(limit ?? 500, 500),
    };
  }
  return input;
}

export function isDashboardAiToolTraceVisible(trace: Pick<DashboardAiToolTraceSummary, 'status' | 'reason' | 'phase' | 'fallbackReason' | 'providerAttempt'>): boolean {
  const reason = `${trace.reason ?? ''} ${trace.fallbackReason ?? ''}`.toLowerCase();
  if (trace.status === 'rejected' || trace.status === 'skipped') return true;
  if (trace.phase === 'rejected_unsafe_render') return true;
  if (typeof trace.providerAttempt === 'number' && trace.providerAttempt > 1) return true;
  if (reason.includes('chưa đồng bộ')) return true;
  if (reason.includes('không truy vấn') || reason.includes('không đủ') || reason.includes('không khớp')) return true;
  if (reason.includes('lỗi') || reason.includes('error') || reason.includes('failed') || reason.includes('invalid')) return true;
  if (reason.includes('cảnh báo') || reason.includes('bị chặn') || reason.includes('blocked') || reason.includes('unsafe')) return true;
  if (reason.includes('thiếu') || reason.includes('vượt giới hạn') || reason.includes('oversize')) return true;
  return false;
}

export function resolveDashboardAiDataRequest(value: unknown): DashboardAiDataRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'type',
    'scope',
    'dateFrom',
    'dateTo',
    'months',
    'weeks',
    'typeFilter',
    'airlines',
    'routes',
    'countries',
    'aircraft',
    'metric',
    'dimension',
    'maxRecords',
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  if (raw.type !== 'dashboard-data-request') return null;
  if (raw.scope !== 'records' && raw.scope !== 'summary' && raw.scope !== 'comparison') return null;
  const dateFrom = optionalIsoDate(raw.dateFrom);
  const dateTo = optionalIsoDate(raw.dateTo);
  if (dateFrom === false || dateTo === false) return null;
  if (dateFrom && dateTo && dateFrom > dateTo) return null;
  const months = optionalKeyList(raw.months, isMonthKey);
  const weeks = optionalKeyList(raw.weeks, isWeekKey);
  const airlines = optionalTextList(raw.airlines, { uppercase: true });
  const routes = optionalTextList(raw.routes, { uppercase: true });
  const countries = optionalTextList(raw.countries);
  const aircraft = optionalTextList(raw.aircraft, { uppercase: true });
  if ([months, weeks, airlines, routes, countries, aircraft].some((entry) => entry === false)) return null;
  const typeFilter = optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const);
  const metric = optionalEnum(raw.metric, ['flights', 'pax'] as const);
  const dimension = optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const);
  if (typeFilter === false || metric === false || dimension === false) return null;
  const maxRecords = optionalPositiveInteger(raw.maxRecords, MAX_DATA_REQUEST_RECORDS);
  if (maxRecords === false) return null;

  const request: DashboardAiDataRequest = {
    type: 'dashboard-data-request',
    scope: raw.scope,
  };
  if (dateFrom) request.dateFrom = dateFrom;
  if (dateTo) request.dateTo = dateTo;
  if (months) request.months = months;
  if (weeks) request.weeks = weeks;
  if (typeFilter) request.typeFilter = typeFilter;
  if (airlines) request.airlines = airlines;
  if (routes) request.routes = routes;
  if (countries) request.countries = countries;
  if (aircraft) request.aircraft = aircraft;
  if (metric) request.metric = metric;
  if (dimension) request.dimension = dimension;
  if (maxRecords) request.maxRecords = maxRecords;
  return request;
}

export function buildDashboardAiResolvedDataRequest(
  request: DashboardAiDataRequest,
  input: {
    records: FlightRecord[];
    routeCountries?: RouteCountryMapping[] | null;
    fallbackFilters?: DashboardAiFilters;
    maxRecords?: number;
  }
): DashboardAiResolvedDataRequest {
  const activeRecords = input.records.filter((record) => record.status !== 'deleted');
  const filteredRecords = activeRecords
    .filter((record) => matchesDataRequest(record, request, input.routeCountries ?? undefined))
    .sort((left, right) => getDashboardOperationalDate(left).localeCompare(getDashboardOperationalDate(right)) || left.schedule.localeCompare(right.schedule));
  const requestedCap = request.maxRecords ?? input.maxRecords ?? DEFAULT_MAX_DATA_REQUEST_RECORDS;
  const maxRecords = Math.max(0, Math.min(requestedCap, input.maxRecords ?? MAX_DATA_REQUEST_RECORDS, MAX_DATA_REQUEST_RECORDS));
  const included = filteredRecords.slice(0, maxRecords);
  const metric = request.metric ?? input.fallbackFilters?.metric ?? 'flights';
  const dimension = request.dimension ?? input.fallbackFilters?.dimension ?? 'airline';
  const timeBasis = input.fallbackFilters?.timeBasis ?? 'local';
  const typeFilter = request.typeFilter ?? input.fallbackFilters?.typeFilter ?? 'all';
  return {
    request,
    totalRecords: filteredRecords.length,
    includedRecords: included.length,
    truncated: filteredRecords.length > included.length,
    records: included.map(toAiSelectedRecord),
    comparison: buildResolvedDataComparison({
      request,
      records: filteredRecords,
      metric,
      dimension,
      typeFilter,
      timeBasis,
      routeCountries: input.routeCountries ?? undefined,
    }),
    aggregations: {
      totals: summarizeRecords('total', 'Total', filteredRecords),
      byMonth: summarizeBy(filteredRecords, (record) => monthKey(getDashboardOperationalDate(record)), (key) => periodLabel(key, 'mom')),
      byWeek: summarizeBy(filteredRecords, (record) => isoWeekKey(getDashboardOperationalDate(record)), (key) => periodLabel(key, 'wow')),
      byDimension: summarizeBy(filteredRecords, (record) => dimensionKey(record, dimension, timeBasis, input.routeCountries ?? undefined), (key) => key, metric),
    },
  };
}

function buildResolvedDataComparison(input: {
  request: DashboardAiDataRequest;
  records: FlightRecord[];
  metric: DashboardMetric;
  dimension: DashboardDimension;
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  routeCountries?: RouteCountryMapping[];
}): DashboardAiResolvedComparison | null {
  const periodPair = resolveDataRequestComparisonPeriods(input.request);
  if (!periodPair) return null;
  const comparison = buildDashboardComparison({
    records: input.records,
    mode: periodPair.mode,
    metric: input.metric,
    currentPeriod: periodPair.currentPeriod,
    previousPeriod: periodPair.previousPeriod,
    typeFilter: input.typeFilter,
    timeBasis: input.timeBasis,
    dimension: input.dimension,
    routeCountries: input.routeCountries,
  });
  const periodKeyForRecord = periodPair.mode === 'mom'
    ? (record: FlightRecord) => monthKey(getDashboardOperationalDate(record))
    : (record: FlightRecord) => isoWeekKey(getDashboardOperationalDate(record));
  const currentRecords = input.records.filter((record) => periodKeyForRecord(record) === periodPair.currentPeriod);
  const previousRecords = input.records.filter((record) => periodKeyForRecord(record) === periodPair.previousPeriod);
  return {
    mode: comparison.mode,
    metric: comparison.metric,
    dimension: comparison.dimension,
    typeFilter: comparison.typeFilter,
    timeBasis: comparison.timeBasis,
    currentPeriod: periodPair.currentPeriod,
    previousPeriod: periodPair.previousPeriod,
    periodLabels: comparison.periodLabels,
    current: summarizeRecords(periodPair.currentPeriod, comparison.periodLabels.current, currentRecords),
    previous: summarizeRecords(periodPair.previousPeriod, comparison.periodLabels.previous, previousRecords),
    delta: comparison.delta,
    deltaPct: comparison.deltaPct,
    drivers: comparison.drivers,
  };
}

function resolveDataRequestComparisonPeriods(request: DashboardAiDataRequest): {
  mode: DashboardComparisonMode;
  currentPeriod: string;
  previousPeriod: string;
} | null {
  if (request.months && request.months.length >= 2) {
    return { mode: 'mom', currentPeriod: request.months[0], previousPeriod: request.months[1] };
  }
  if (request.weeks && request.weeks.length >= 2) {
    return { mode: 'wow', currentPeriod: request.weeks[0], previousPeriod: request.weeks[1] };
  }
  return null;
}

export function capDashboardAiLocalHistory(
  messages: Array<Partial<DashboardAiStoredMessage> & DashboardAiChatMessage>,
  options: DashboardAiLocalHistoryOptions = {}
): DashboardAiStoredMessage[] {
  const maxMessages = options.maxMessages ?? DASHBOARD_AI_LOCAL_HISTORY_MAX_MESSAGES;
  const maxBytes = options.maxBytes ?? DASHBOARD_AI_LOCAL_HISTORY_MAX_BYTES;
  const sanitized = messages
    .map((message, index): DashboardAiStoredMessage | null => {
      const stored: DashboardAiStoredMessage = {
        id: String(message.id ?? `ai-${message.createdAt ?? Date.now()}-${index}`),
        role: message.role,
        content: String(message.content ?? ''),
        createdAt: Number(message.createdAt ?? Date.now()),
      };
      if (message.modelId) stored.modelId = String(message.modelId);
      if (
        (stored.role !== 'user' && stored.role !== 'assistant') ||
        stored.content.length === 0 ||
        !Number.isFinite(stored.createdAt)
      ) return null;
      return stored;
    })
    .filter((message): message is DashboardAiStoredMessage => message != null)
    .slice(-Math.max(0, maxMessages));
  while (sanitized.length > 0 && byteLength(JSON.stringify(sanitized)) > maxBytes) {
    sanitized.shift();
  }
  return sanitized;
}

export function loadDashboardAiLocalHistory(storageKey: string, storage?: Storage | null): DashboardAiStoredMessage[] {
  if (!storage) return [];
  const raw = storage.getItem(storageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? capDashboardAiLocalHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function saveDashboardAiLocalHistory(
  storageKey: string,
  messages: DashboardAiStoredMessage[],
  storage?: Storage | null
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(capDashboardAiLocalHistory(messages)));
  } catch {
    // Local chat history is convenience-only; quota failures should not affect analysis.
  }
}

async function readFunctionInvokeError(error: unknown): Promise<string> {
  if (error && typeof error === 'object') {
    const context = (error as { context?: { json?: () => Promise<unknown> } }).context;
    if (context?.json) {
      try {
        const payload = await context.json();
        const message = readErrorMessage(payload);
        if (message) return message;
      } catch {
        // Fall through to message extraction below.
      }
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'AI analysis request failed.';
}

function readAssistantResponse(data: unknown): DashboardAiAnalysisResponse {
  if (data && typeof data === 'object') {
    const text = (data as { assistantText?: unknown }).assistantText;
    if (typeof text === 'string' && text.trim()) {
      return {
        assistantText: text.trim(),
        exportAction: resolveDashboardAiExportAction((data as { exportAction?: unknown }).exportAction),
        dataRequest: resolveDashboardAiDataRequest((data as { dataRequest?: unknown }).dataRequest),
        queryResults: resolveDashboardAiQueryResults((data as { queryResults?: unknown }).queryResults),
        sqlQueryPlans: resolveDashboardAiSqlQueryPlans((data as { sqlQueryPlans?: unknown }).sqlQueryPlans),
        resultProfiles: resolveDashboardAiResultProfiles((data as { resultProfiles?: unknown }).resultProfiles),
        answerVerification: resolveDashboardAiAnswerVerification((data as { answerVerification?: unknown }).answerVerification),
        visualReport: resolveDashboardAiVisualReport((data as { visualReport?: unknown }).visualReport),
        boardPatch: resolveDashboardAiBoardPatch((data as { boardPatch?: unknown }).boardPatch),
        toolTraceSummary: resolveDashboardAiToolTraceSummary((data as { toolTraceSummary?: unknown }).toolTraceSummary),
        workflowId: typeof (data as { workflowId?: unknown }).workflowId === 'string'
          ? (data as { workflowId: string }).workflowId
          : null,
        preparedDataContracts: resolveDashboardAiPreparedDataContracts(
          (data as { preparedDataContracts?: unknown }).preparedDataContracts
        ),
        workflowTraceSummary: resolveDashboardAiToolTraceSummary(
          (data as { workflowTraceSummary?: unknown }).workflowTraceSummary
        ),
      };
    }
  }
  throw new DashboardAiRequestError('AI provider returned an empty analysis response.');
}

function resolveDashboardAiPreparedDataContracts(value: unknown): DashboardAiPreparedDataContract[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const contracts: DashboardAiPreparedDataContract[] = [];
  for (const item of value.slice(0, DASHBOARD_AI_MAX_ROUNDS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const queryId = sanitizeSqlPlanIdentifier(raw.queryId, '');
    if (!queryId) continue;
    const dateRangeRaw = raw.dateRange;
    let dateRange: DashboardAiPreparedDataContract['dateRange'] | undefined;
    if (dateRangeRaw && typeof dateRangeRaw === 'object' && !Array.isArray(dateRangeRaw)) {
      const range = dateRangeRaw as Record<string, unknown>;
      const from = sanitizeDisplayText(range.from, '', 24);
      const to = sanitizeDisplayText(range.to, '', 24);
      const field = sanitizeSqlPlanIdentifier(range.field, '');
      if (from && to && field) dateRange = { from, to, field };
    }
    contracts.push({
      queryId,
      grain: sanitizeSqlPlanIdentifier(raw.grain, 'row'),
      ...(dateRange ? { dateRange } : {}),
      filters: {},
      metrics: Array.isArray(raw.metrics) ? raw.metrics.slice(0, 16).map((metric) => sanitizeSqlPlanIdentifier(metric, '')).filter(Boolean) : [],
      dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.slice(0, 16).map((dimension) => sanitizeSqlPlanIdentifier(dimension, '')).filter(Boolean) : [],
      rowCount: typeof raw.rowCount === 'number' && Number.isFinite(raw.rowCount) ? Math.max(0, Math.floor(raw.rowCount)) : 0,
      truncated: raw.truncated === true,
      qualityNotes: Array.isArray(raw.qualityNotes) ? raw.qualityNotes.slice(0, 8).map((note) => sanitizeDisplayText(note, '', 240)).filter(Boolean) : [],
      trusted: raw.trusted === true,
    });
  }
  return contracts.length > 0 ? contracts : undefined;
}

function resolveDashboardAiResultProfiles(value: unknown): DashboardAiResultProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const profiles: DashboardAiResultProfile[] = [];
  for (const item of value.slice(0, DASHBOARD_AI_MAX_ROUNDS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const queryId = sanitizeSqlPlanIdentifier(raw.queryId, '');
    if (!queryId) continue;
    profiles.push({
      queryId,
      rowCount: typeof raw.rowCount === 'number' ? Math.max(0, Math.floor(raw.rowCount)) : 0,
      truncated: raw.truncated === true,
      columns: Array.isArray(raw.columns) ? raw.columns.slice(0, 32).map((column) => sanitizeSqlPlanIdentifier(column, '')).filter(Boolean) : [],
      nullCounts: sanitizeNumericRecord(raw.nullCounts),
      distinctCounts: sanitizeNumericRecord(raw.distinctCounts),
      metricStats: {},
      topValues: {},
      outlierCandidates: [],
      dataQualityNotes: Array.isArray(raw.dataQualityNotes) ? raw.dataQualityNotes.slice(0, 8).map((note) => sanitizeDisplayText(note, '', 240)).filter(Boolean) : [],
    });
  }
  return profiles.length > 0 ? profiles : undefined;
}

function resolveDashboardAiAnswerVerification(value: unknown): DashboardAiAnswerVerification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status === 'warning' ? 'warning' : raw.status === 'passed' || raw.status === 'verified' ? 'passed' : null;
  if (!status) return undefined;
  return {
    status,
    reasonVi: sanitizeDisplayText(raw.reasonVi, status === 'passed' ? 'Các số liệu chính khớp query result/profile.' : 'Một số số liệu cần kiểm tra lại.', 240),
    unsupportedNumbers: Array.isArray(raw.unsupportedNumbers) ? raw.unsupportedNumbers.slice(0, 12).map((item) => sanitizeDisplayText(item, '', 40)).filter(Boolean) : [],
    queryIds: Array.isArray(raw.queryIds) ? raw.queryIds.slice(0, DASHBOARD_AI_MAX_ROUNDS).map((item) => sanitizeSqlPlanIdentifier(item, '')).filter(Boolean) : [],
  };
}

function sanitizeNumericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 32)) {
    const name = sanitizeSqlPlanIdentifier(key, '');
    if (!name || typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue;
    output[name] = rawValue;
  }
  return output;
}

function resolveDashboardAiSqlQueryPlans(value: unknown): DashboardAiSqlQueryPlan[] {
  if (!Array.isArray(value)) return [];
  const plans: DashboardAiSqlQueryPlan[] = [];
  for (const item of value.slice(0, DASHBOARD_AI_MAX_ROUNDS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const sql = typeof raw.sql === 'string' ? raw.sql.trim() : '';
    if (!isSafeDashboardAiSqlCandidate(sql)) continue;
    const queryId = sanitizeSqlPlanIdentifier(raw.queryId, `sql-${plans.length + 1}`);
    const params = Array.isArray(raw.params)
      ? raw.params.slice(0, 24).map(sanitizeWorkbookCell)
      : [];
    const expectedColumns = Array.isArray(raw.expectedColumns)
      ? raw.expectedColumns.slice(0, 24).map((column) => sanitizeSqlPlanIdentifier(column, '')).filter(Boolean)
      : [];
    const visualizationHint = DASHBOARD_AI_WORKSPACE_CHART_TYPES.includes(raw.visualizationHint as DashboardAiWorkspaceChartType)
      ? raw.visualizationHint as DashboardAiWorkspaceChartType
      : 'table';
    const source = raw.source === 'supabase-reporting' || raw.source === 'mixed'
      ? raw.source
      : 'local-sqlite';
    plans.push({
      queryId,
      sql,
      params,
      reasonVi: sanitizeDisplayText(raw.reasonVi, 'Truy vấn SQLite local read-only theo yêu cầu phân tích.', 240),
      expectedColumns,
      visualizationHint,
      source,
      ...(typeof raw.workflowId === 'string' ? { workflowId: sanitizeSqlPlanIdentifier(raw.workflowId, '') as DashboardAiSqlQueryPlan['workflowId'] } : {}),
    });
  }
  return plans;
}

function sanitizeSqlPlanIdentifier(value: unknown, fallback: string): string {
  return sanitizeDisplayText(value, fallback, 64).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function isSafeDashboardAiSqlCandidate(sql: string): boolean {
  if (!sql || sql.length > 6000 || sql.includes(';')) return false;
  const upper = sql.toUpperCase();
  if (!(upper.startsWith('SELECT ') || upper.startsWith('WITH '))) return false;
  if (!upper.includes('DASHBOARD_AI_FLIGHT_OPERATIONS')) return false;
  return !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|REPLACE|TRUNCATE|BEGIN|COMMIT|ROLLBACK|LOAD_EXTENSION)\b/.test(upper);
}

function sanitizeDashboardCustomWorkbookSpec(value: unknown): DashboardCustomWorkbookSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = sanitizeDisplayText(raw.title, 'Custom Dashboard Workbook', 80);
  if (!Array.isArray(raw.sheets)) return null;
  const sheets: DashboardCustomWorkbookSheet[] = [];
  let remainingRows = DASHBOARD_CUSTOM_WORKBOOK_LIMITS.maxRowsPerWorkbook;
  for (const sheetValue of raw.sheets.slice(0, DASHBOARD_CUSTOM_WORKBOOK_LIMITS.maxSheets)) {
    if (!sheetValue || typeof sheetValue !== 'object' || Array.isArray(sheetValue)) continue;
    const sheetRaw = sheetValue as Record<string, unknown>;
    const columns = sanitizeColumns(sheetRaw.columns);
    if (columns.length === 0 || !Array.isArray(sheetRaw.rows) || remainingRows <= 0) continue;
    const rows: Record<string, DashboardCustomWorkbookCell>[] = [];
    for (const rowValue of sheetRaw.rows.slice(0, remainingRows)) {
      const row = sanitizeWorkbookRow(rowValue, columns);
      if (row) rows.push(row);
    }
    remainingRows -= rows.length;
    sheets.push({
      name: uniqueSheetName(sanitizeSheetName(sheetRaw.name, `Sheet ${sheets.length + 1}`), sheets.map((sheet) => sheet.name)),
      columns,
      rows,
      ...(typeof sheetRaw.notes === 'string' && sheetRaw.notes.trim()
        ? { notes: sanitizeDisplayText(sheetRaw.notes, '', 500) }
        : {}),
    });
  }
  return sheets.length > 0 ? { title, sheets } : null;
}

function sanitizeColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const columns: string[] = [];
  for (const entry of value.slice(0, DASHBOARD_CUSTOM_WORKBOOK_LIMITS.maxColumnsPerSheet)) {
    const label = uniqueColumnName(sanitizeDisplayText(entry, '', 64), columns);
    if (label) columns.push(label);
  }
  return columns;
}

function sanitizeWorkbookRow(value: unknown, columns: string[]): Record<string, DashboardCustomWorkbookCell> | null {
  if (!value || typeof value !== 'object') return null;
  const row: Record<string, DashboardCustomWorkbookCell> = {};
  let hasValue = false;
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const raw = Array.isArray(value)
      ? value[index]
      : (value as Record<string, unknown>)[column];
    const cell = sanitizeWorkbookCell(raw);
    row[column] = cell;
    if (cell !== null && cell !== '') hasValue = true;
  }
  return hasValue ? row : null;
}

function sanitizeWorkbookCell(value: unknown): DashboardCustomWorkbookCell {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.slice(0, DASHBOARD_CUSTOM_WORKBOOK_LIMITS.maxCellChars);
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function sanitizeQueryTableData(rowsValue: unknown, columnsValue: unknown): {
  columns: string[];
  rows: Record<string, DashboardAiQueryCell>[];
} {
  const explicitColumns = sanitizeColumns(columnsValue).slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxColumns);
  const rows = sanitizeQueryRows(rowsValue, explicitColumns);
  const derivedColumns = explicitColumns.length > 0
    ? explicitColumns
    : rows.reduce<string[]>((columns, row) => {
        for (const key of Object.keys(row)) {
          const column = uniqueColumnName(sanitizeDisplayText(key, '', 64), columns);
          if (column) columns.push(column);
          if (columns.length >= DASHBOARD_AI_WORKSPACE_LIMITS.maxColumns) break;
        }
        return columns;
      }, []);
  return {
    columns: derivedColumns,
    rows: derivedColumns.length > 0
      ? rows.map((row) => {
          const normalized: Record<string, DashboardAiQueryCell> = {};
          for (const column of derivedColumns) normalized[column] = sanitizeWorkbookCell(row[column]);
          return normalized;
        })
      : rows,
  };
}

function sanitizeQueryRows(value: unknown, preferredColumns: string[] = []): Record<string, DashboardAiQueryCell>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, DashboardAiQueryCell>[] = [];
  for (const rowValue of value.slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlockLimit)) {
    if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) continue;
    const raw = rowValue as Record<string, unknown>;
    const keys = preferredColumns.length > 0
      ? preferredColumns
      : Object.keys(raw).slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxColumns);
    const row: Record<string, DashboardAiQueryCell> = {};
    let hasValue = false;
    for (const key of keys) {
      const column = sanitizeDisplayText(key, '', 64);
      if (!column) continue;
      const cell = sanitizeWorkbookCell(raw[key]);
      row[column] = cell;
      if (cell !== null && cell !== '') hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

function sanitizeWorkbookFileName(value: unknown, fallbackTitle: string): string {
  const source = typeof value === 'string' && value.trim() ? value : fallbackTitle;
  const withoutExtension = source.replace(/\.xlsx$/i, '');
  const normalized = withoutExtension
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\.+/g, ' ')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `${normalized || 'dashboard_custom_workbook'}.xlsx`;
}

function sanitizeSheetName(value: unknown, fallback: string): string {
  return sanitizeDisplayText(value, fallback, 31)
    .replace(/[\[\]:*?/\\]/g, ' ')
    .replace(/^[=+\-@]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || fallback;
}

function sanitizeDisplayText(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return normalized || fallback;
}

function uniqueSheetName(name: string, existing: string[]): string {
  let candidate = name.slice(0, 31) || 'Sheet';
  let index = 2;
  while (existing.includes(candidate)) {
    const suffix = ` ${index}`;
    candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  return candidate;
}

function uniqueColumnName(name: string, existing: string[]): string {
  if (!name) return '';
  let candidate = name;
  let index = 2;
  while (existing.includes(candidate)) {
    candidate = `${name.slice(0, 60)} ${index}`;
    index += 1;
  }
  return candidate;
}

function normalizePromptForToolRouting(prompt: string): string {
  return normalizeSharedDashboardAiPromptForToolRouting(prompt);
}

function isDashboardAiQueryIntentPrompt(prompt: string): boolean {
  return isSharedDashboardAiQueryIntentPrompt(prompt);
}

function isDashboardAiWorkspaceBoardIntent(prompt: string): boolean {
  const normalized = normalizePromptForToolRouting(prompt);
  if (/\b(export|download|excel|xlsx)\b/.test(normalized)) return false;
  const wantsReportTable = /\breport\b/.test(normalized) && !/\b(export|download|excel|xlsx)\b/.test(normalized);
  const wantsThreeSeasonComparison = /\bso sanh\s*3\b/.test(normalized);
  return wantsReportTable ||
    wantsThreeSeasonComparison ||
    /\b(ai workspace|workspace|whiteboard|board|canvas|bang trang|block board|multi-season|three seasons|3 seasons|so sanh 3 mua|compare selected seasons|visual|visual report|chart|graph|plot|ve|bieu do|dashboard visual|peak hour|table|bang|report dang bang|lap report dang bang|driver table|create driver table|draw peak hour chart|build visual report|build ai workspace board)\b/.test(normalized);
}

function isCompareSeasonsPrompt(normalizedPrompt: string): boolean {
  return /\b(compare selected seasons|multi-season|three seasons|3 seasons|so sanh 3 mua|selected seasons)\b/.test(normalizedPrompt);
}

function isDifferenceComparisonPrompt(normalizedPrompt: string): boolean {
  const hasComparison = /\b(so sanh|compare|comparison|vs|voi|with)\b/.test(normalizedPrompt);
  const hasDifference = /\b(khac biet|diem khac biet|noi bat|difference|differences|delta|change|changes|bien dong|tang|giam|drop|drivers?)\b/.test(normalizedPrompt);
  const hasPeriod = /\b(thang|month|week|tuan|period|\d{4}-\d{2})\b/.test(normalizedPrompt);
  const hasDimension = /\b(theo|route|duong bay|hang bay|airline|country|quoc gia|aircraft|may bay|gio|hour|local hour|type|arr|dep)\b/.test(normalizedPrompt);
  const wantsTable = /\b(bang|table|report)\b/.test(normalizedPrompt);
  return (hasComparison && hasPeriod && (hasDifference || wantsTable || hasDimension)) || (hasDifference && wantsTable && hasPeriod);
}

function isPeakHourPrompt(normalizedPrompt: string): boolean {
  return /\b(peak hour|bieu do peak hour|khung gio cao diem)\b/.test(normalizedPrompt);
}

function isDriverPrompt(normalizedPrompt: string): boolean {
  return /\b(driver|drivers|tac nhan|ctg|waterfall|create driver table)\b/.test(normalizedPrompt);
}

function isTablePrompt(normalizedPrompt: string): boolean {
  return /\b(table|bang|report dang bang|lap report dang bang)\b/.test(normalizedPrompt);
}

function isVisualPrompt(normalizedPrompt: string): boolean {
  return /\b(visual|visual report|chart|graph|plot|ve|bieu do|dashboard visual|build visual report)\b/.test(normalizedPrompt);
}

function visualTemplateTitle(templateId: DashboardVisualReportTemplateId): string {
  if (templateId === 'season-overview') return 'Tá»•ng quan mÃ¹a';
  if (templateId === 'driver-waterfall') return 'Waterfall tÃ¡c nhÃ¢n';
  if (templateId === 'peak-hour') return 'Khung giá» cao Ä‘iá»ƒm';
  if (templateId === 'route-country') return 'ÄÆ°á»ng bay / quá»‘c gia';
  return 'CÆ¡ cáº¥u hÃ£ng bay';
}

function buildDashboardAiBoardPatchFromVisualReport(report: DashboardVisualReportSpec): DashboardAiBoardPatch | null {
  const blocks: Array<Record<string, unknown>> = [];
  for (const visualBlock of report.blocks) {
    const block = convertVisualBlockToWorkspaceBlock(visualBlock, report.filters);
    if (block) blocks.push(block);
  }
  if (report.insights.length > 0) {
    blocks.push(workspaceInsightBlock('visual-insights', 'Nháº­n Ä‘á»‹nh chÃ­nh', 'comparison', report.insights));
  }
  if (report.dataQualityNotes.length > 0) {
    blocks.push(workspaceInsightBlock('visual-data-quality', 'Ghi chÃº cháº¥t lÆ°á»£ng dá»¯ liá»‡u', 'overview', report.dataQualityNotes, 'data-quality-notes'));
  }
  return resolveDashboardAiBoardPatch({
    title: report.title,
    blocks,
    append: false,
  });
}

function convertVisualBlockToWorkspaceBlock(
  block: DashboardVisualReportBlock,
  filters: DashboardAiFilters
): Record<string, unknown> | null {
  const baseFilters = {
    comparisonMode: filters.comparisonMode,
    metric: block.metric ?? filters.metric,
    typeFilter: filters.typeFilter,
    timeBasis: filters.timeBasis,
  };
  if (block.type === 'kpi-summary') {
    return workspaceKpiBlock(`visual-${block.id}`, block.title, block.source);
  }
  if (block.type === 'monthly-trend') {
    return workspaceChartBlock(`visual-${block.id}`, block.title, 'overview', 'line-trend', {
      ...baseFilters,
      dimension: 'month',
    }, block.limit ?? 12);
  }
  if (block.type === 'driver-waterfall') {
    return workspaceChartBlock(`visual-${block.id}`, block.title, 'comparison', 'waterfall', {
      ...baseFilters,
      dimension: block.dimension ?? filters.dimension,
    }, block.limit ?? 12);
  }
  if (block.type === 'peak-hour') {
    return workspaceChartBlock(`visual-${block.id}`, block.title, 'overview', 'bar-ranking', {
      ...baseFilters,
      dimension: 'hourBucket',
    }, block.limit ?? 12);
  }
  if (block.type === 'route-country-ranking') {
    return workspaceChartBlock(`visual-${block.id}`, block.title, 'overview', 'bar-ranking', {
      ...baseFilters,
      dimension: 'route',
    }, block.limit ?? 12);
  }
  if (block.type === 'airline-mix-ranking') {
    return workspaceChartBlock(`visual-${block.id}`, block.title, 'overview', 'bar-ranking', {
      ...baseFilters,
      dimension: 'airline',
    }, block.limit ?? 12);
  }
  return workspaceInsightBlock(`visual-${block.id}`, block.title, block.source, ['Kiá»ƒm tra block trá»±c quan nÃ y tá»« bÃ¡o cÃ¡o AI.']);
}

function buildDashboardAiDefaultBoardPatch(prompt: string): DashboardAiBoardPatch | null {
  const normalized = normalizePromptForToolRouting(prompt);
  if (isDifferenceComparisonPrompt(normalized)) return defaultDifferenceComparisonBoardPatch(prompt);
  if (isCompareSeasonsPrompt(normalized)) return defaultCompareSeasonsBoardPatch();
  if (isPeakHourPrompt(normalized)) return defaultPeakHourBoardPatch();
  if (isDriverPrompt(normalized)) return defaultDriverBoardPatch();
  if (isTablePrompt(normalized)) return defaultTableBoardPatch();
  if (isVisualPrompt(normalized)) return defaultVisualBoardPatch();
  if (isDashboardAiWorkspaceBoardIntent(normalized)) return defaultWorkspaceBoardPatch();
  return null;
}

function defaultDifferenceComparisonBoardPatch(prompt: string): DashboardAiBoardPatch | null {
  const baseFilters = comparisonDifferenceFilters(prompt);
  const blocks: Array<Record<string, unknown>> = [
    workspaceTableBlock('difference-driver-table', 'Bảng khác biệt driver từ truy vấn độc lập', 'resolvedDataRequest', 'custom-table', 12, baseFilters),
    workspaceChartBlock('difference-waterfall', 'Waterfall biến động từ query result', 'resolvedDataRequest', 'waterfall', { ...baseFilters, dimension: 'airline', metric: 'flights' }, 12),
  ];
  if (shouldIncludeRouteDifferenceBlocks(prompt)) {
    blocks.push(
      workspaceTableBlock('difference-route-table', 'Bảng driver theo đường bay từ truy vấn độc lập', 'resolvedDataRequest', 'custom-table', 12, { ...baseFilters, dimension: 'route', metric: 'flights' }),
      workspaceChartBlock('difference-route-waterfall', 'Waterfall biến động theo đường bay từ query result', 'resolvedDataRequest', 'waterfall', { ...baseFilters, dimension: 'route', metric: 'flights' }, 12)
    );
  }
  blocks.push(workspaceInsightBlock('difference-notes', 'Nhận định khác biệt', 'resolvedDataRequest', ['AI Workspace sẽ ưu tiên SQL local độc lập theo kỳ/dimension trong prompt; không dùng bảng MoM/WoW hiện tại.']));
  return resolveDashboardAiBoardPatch({
    title: comparisonDifferenceBoardTitle(prompt),
    blocks,
    append: false,
  });
}

function defaultVisualBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng bÃ¡o cÃ¡o trá»±c quan AI',
    blocks: [
      workspaceKpiBlock('visual-kpis', 'KPI tá»•ng quan', 'overview'),
      workspaceChartBlock('visual-monthly-trend', 'Xu hÆ°á»›ng chuyáº¿n bay theo thÃ¡ng', 'overview', 'line-trend', { dimension: 'month', metric: 'flights' }, 12),
      workspaceChartBlock('visual-peak-hour', 'PhÃ¢n bá»• khung giá» cao Ä‘iá»ƒm', 'overview', 'bar-ranking', { dimension: 'hourBucket', metric: 'flights' }, 12),
      workspaceTableBlock('visual-airline-ranking', 'Báº£ng xáº¿p háº¡ng hÃ£ng bay', 'overview', 'airline-ranking', 12),
      workspaceInsightBlock('visual-board-notes', 'Nháº­n Ä‘á»‹nh phÃ¢n tÃ­ch', 'resolvedDataRequest', ['CÃ¡c block Ä‘Æ°á»£c táº¡o tá»« truy váº¥n dashboard local Ä‘á»™c láº­p.']),
    ],
    append: false,
  });
}

function defaultPeakHourBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng phÃ¢n tÃ­ch khung giá» cao Ä‘iá»ƒm',
    blocks: [
      workspaceChartBlock('peak-hour-chart', 'PhÃ¢n bá»• khung giá» cao Ä‘iá»ƒm', 'overview', 'bar-ranking', { dimension: 'hourBucket', metric: 'flights' }, 24),
      workspaceTableBlock('peak-hour-table', 'Báº£ng khung giá» cao Ä‘iá»ƒm', 'overview', 'peak-hour', 24),
      workspaceInsightBlock('peak-hour-notes', 'Ghi chÃº peak hour', 'overview', ['Block peak hour sá»­ dá»¥ng time basis vÃ  filter dashboard Ä‘ang chá»n.']),
    ],
    append: false,
  });
}

function defaultDriverBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng phÃ¢n tÃ­ch tÃ¡c nhÃ¢n',
    blocks: [
      workspaceTableBlock('driver-table', 'Báº£ng Ä‘Ã³ng gÃ³p tÃ¡c nhÃ¢n', 'resolvedDataRequest', 'custom-table', 12),
      workspaceChartBlock('driver-waterfall', 'Waterfall tÃ¡c nhÃ¢n', 'resolvedDataRequest', 'waterfall', { dimension: 'airline', metric: 'flights' }, 12),
      workspaceInsightBlock('driver-notes', 'Ghi chÃº tÃ¡c nhÃ¢n', 'resolvedDataRequest', ['Block tÃ¡c nhÃ¢n chá»‰ render tá»« queryResults/sourceQueryId há»£p lá»‡ cá»§a AI Workspace.']),
    ],
    append: false,
  });
}

function defaultCompareSeasonsBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng so sÃ¡nh cÃ¡c mÃ¹a Ä‘Ã£ chá»n',
    blocks: [
      workspaceTableBlock('multi-season-summary', 'Tá»•ng há»£p cÃ¡c mÃ¹a Ä‘Ã£ chá»n', 'multiSeason', 'multi-season-summary', 3),
      workspaceChartBlock('multi-season-chart', 'Chuyáº¿n bay theo mÃ¹a Ä‘Ã£ chá»n', 'multiSeason', 'bar-ranking', { dimension: 'season', metric: 'flights' }, 3),
      workspaceInsightBlock('multi-season-notes', 'Ghi chÃº so sÃ¡nh', 'multiSeason', ['Block multi-season giá»›i háº¡n theo tá»‘i Ä‘a 3 mÃ¹a Ä‘Ã£ chá»n.']),
    ],
    append: false,
  });
}

function defaultTableBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng bÃ¡o cÃ¡o dáº¡ng báº£ng',
    blocks: [
      workspaceTableBlock('season-summary-table', 'Báº£ng tá»•ng há»£p mÃ¹a', 'multiSeason', 'season-summary', 3),
      workspaceTableBlock('airline-ranking-table', 'Báº£ng xáº¿p háº¡ng hÃ£ng bay', 'overview', 'airline-ranking', 12),
      workspaceTableBlock('route-country-table', 'Báº£ng Ä‘Æ°á»ng bay / quá»‘c gia', 'overview', 'route-country-ranking', 12),
    ],
    append: false,
  });
}

function defaultWorkspaceBoardPatch(): DashboardAiBoardPatch | null {
  return resolveDashboardAiBoardPatch({
    title: 'Báº£ng AI Workspace',
    blocks: [
      workspaceKpiBlock('workspace-kpis', 'KPI tá»•ng quan', 'overview'),
      workspaceTableBlock('workspace-season-summary', 'Tá»•ng há»£p mÃ¹a Ä‘Ã£ chá»n', 'multiSeason', 'season-summary', 3),
      workspaceChartBlock('workspace-monthly-trend', 'Xu hÆ°á»›ng chuyáº¿n bay theo thÃ¡ng', 'overview', 'line-trend', { dimension: 'month', metric: 'flights' }, 12),
      workspaceChartBlock('workspace-airline-ranking', 'Top hÃ£ng bay', 'overview', 'bar-ranking', { dimension: 'airline', metric: 'flights' }, 12),
    ],
    append: false,
  });
}

function workspaceKpiBlock(id: string, title: string, source: DashboardAiWorkspaceBlockSource): Record<string, unknown> {
  return { id, type: 'kpi', title, source };
}

function workspaceChartBlock(
  id: string,
  title: string,
  source: DashboardAiWorkspaceBlockSource,
  chartType: DashboardAiWorkspaceChartType,
  filters: Record<string, string>,
  limit: number
): Record<string, unknown> {
  return {
    id,
    type: 'chart',
    title,
    source,
    chart: {
      chartType,
      title,
      source,
      filters,
      series: ['flights'],
      limit,
    },
  };
}

function workspaceTableBlock(
  id: string,
  title: string,
  source: DashboardAiWorkspaceBlockSource,
  templateId: DashboardAiWorkspaceTableTemplateId,
  limit: number,
  filters: Record<string, string> = {}
): Record<string, unknown> {
  return {
    id,
    type: 'table',
    title,
    source,
    table: {
      templateId,
      title,
      columns: ['label', 'flights'],
      source,
      filters,
      limit,
    },
  };
}

function workspaceInsightBlock(
  id: string,
  title: string,
  source: DashboardAiWorkspaceBlockSource,
  insights: string[],
  type: 'insight-list' | 'data-quality-notes' = 'insight-list'
): Record<string, unknown> {
  return { id, type, title, source, insights };
}

function comparisonDifferenceBoardTitle(prompt: string): string {
  const normalized = normalizePromptForToolRouting(prompt);
  const monthNumbers = Array.from(normalized.matchAll(/\bthang\s*(1[0-2]|0?[1-9])\b/g)).map((match) => Number(match[1]));
  if (monthNumbers.length >= 2) {
    return `Báº£ng khÃ¡c biá»‡t thÃ¡ng ${monthNumbers[0]} vs thÃ¡ng ${monthNumbers[1]}`;
  }
  const monthKeys = Array.from(normalized.matchAll(/\b(\d{4}-\d{2})\b/g)).map((match) => match[1]);
  if (monthKeys.length >= 2) {
    return `Báº£ng khÃ¡c biá»‡t ${monthKeys[0]} vs ${monthKeys[1]}`;
  }
  return 'Báº£ng so sÃ¡nh khÃ¡c biá»‡t theo ká»³';
}

function comparisonDifferenceFilters(prompt: string): Record<string, string> {
  const normalized = normalizePromptForToolRouting(prompt);
  const monthNumbers = Array.from(normalized.matchAll(/\bthang\s*(1[0-2]|0?[1-9])\b/g)).map((match) => String(Number(match[1])).padStart(2, '0'));
  const monthKeys = Array.from(normalized.matchAll(/\b(\d{4}-\d{2})\b/g)).map((match) => match[1]);
  if (monthKeys.length >= 2) {
    return { comparisonMode: 'mom', currentPeriod: monthKeys[0], previousPeriod: monthKeys[1] };
  }
  if (monthNumbers.length >= 2) {
    return { comparisonMode: 'mom', currentMonth: monthNumbers[0], previousMonth: monthNumbers[1] };
  }
  return { comparisonMode: 'mom' };
}

function shouldIncludeRouteDifferenceBlocks(prompt: string): boolean {
  const normalized = normalizePromptForToolRouting(prompt);
  return /\b(route|duong bay|routes?)\b/.test(normalized) || /\b(diem khac biet|noi bat|differences?|drivers?)\b/.test(normalized);
}

function inferPromptTypeFilter(normalizedPrompt: string): DashboardTypeFilter {
  if (/\b(arr|arrival|arrivals)\b/.test(normalizedPrompt)) return 'A';
  if (/\b(dep|departure|departures)\b/.test(normalizedPrompt)) return 'D';
  return 'all';
}

function inferPromptMonthPair(text: string, context: DashboardAiContext): string[] | null {
  const normalized = normalizePromptForToolRouting(text);
  const explicitMonthKeys = Array.from(normalized.matchAll(/\b(\d{4}-\d{2})\b/g)).map((match) => match[1]);
  if (explicitMonthKeys.length >= 2) return explicitMonthKeys.slice(0, 2);
  const slashMonthKeys = Array.from(normalized.matchAll(/\b(1[0-2]|0?[1-9])\/(\d{4})\b/g)).map((match) => `${match[2]}-${String(Number(match[1])).padStart(2, '0')}`);
  if (slashMonthKeys.length >= 2) return slashMonthKeys.slice(0, 2);
  const vietnameseMonthNumbers = Array.from(normalized.matchAll(/\bthang\s*(1[0-2]|0?[1-9])(?:\/(\d{4}))?\b/g)).map((match) => ({
    month: String(Number(match[1])).padStart(2, '0'),
    year: match[2],
  }));
  const fallbackYear = inferComparisonYear(context);
  if (vietnameseMonthNumbers.length >= 2) {
    return vietnameseMonthNumbers.slice(0, 2).map((entry) => `${entry.year ?? fallbackYear}-${entry.month}`);
  }
  const looseMonthNumbers = Array.from(normalized.matchAll(/\b(1[0-2]|0?[1-9])\b/g))
    .map((match) => String(Number(match[1])).padStart(2, '0'));
  if (normalized.includes('thang') && looseMonthNumbers.length >= 2) {
    return looseMonthNumbers.slice(0, 2).map((month) => `${fallbackYear}-${month}`);
  }
  return null;
}

function inferComparisonYear(context: DashboardAiContext): string {
  const currentPeriodYear = context.comparison?.current?.key?.match(/^(\d{4})-/)?.[1];
  if (currentPeriodYear) return currentPeriodYear;
  const firstCatalogYear = context.seasonCatalog.months[0]?.key?.match(/^(\d{4})-/)?.[1];
  if (firstCatalogYear) return firstCatalogYear;
  const dateRangeYear = context.seasonCatalog.dateRange.from.match(/^(\d{4})-/)?.[1];
  return dateRangeYear ?? new Date().getFullYear().toString();
}

function formatSignedNumber(value: number): string {
  const formatted = Math.abs(value).toLocaleString('en-US');
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function formatNullablePercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function sanitizeVisualReportFilters(value: unknown): DashboardAiFilters {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    comparisonMode: optionalEnum(raw.comparisonMode, ['mom', 'wow'] as const) || 'mom',
    metric: optionalEnum(raw.metric, ['flights', 'pax'] as const) || 'flights',
    typeFilter: optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const) || 'all',
    dimension: optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const) || 'airline',
    timeBasis: optionalEnum(raw.timeBasis, ['local', 'utc'] as const) || 'local',
  };
}

function sanitizeVisualReportBlock(value: unknown, index: number): DashboardVisualReportBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = optionalEnum(raw.type, ['kpi-summary', 'monthly-trend', 'driver-waterfall', 'peak-hour', 'route-country-ranking', 'airline-mix-ranking', 'insight-notes'] as const);
  const source = optionalEnum(raw.source, ['overview', 'comparison', 'seasonCatalog', 'resolvedDataRequest'] as const);
  if (!type || !source) return null;
  const block: DashboardVisualReportBlock = {
    id: sanitizeBlockId(raw.id, `block-${index + 1}`),
    type,
    title: sanitizeVisualText(raw.title, visualBlockTitle(type), 80),
    source,
  };
  const metric = optionalEnum(raw.metric, ['flights', 'pax'] as const);
  const dimension = optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const);
  const limit = optionalPositiveInteger(raw.limit, DASHBOARD_VISUAL_REPORT_LIMITS.maxBlockLimit);
  if (metric) block.metric = metric;
  if (dimension) block.dimension = dimension;
  if (limit) block.limit = limit;
  return block;
}

function sanitizeDashboardAiWorkspaceBlock(value: unknown, index: number): DashboardAiWorkspaceBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = optionalEnum(raw.type, DASHBOARD_AI_WORKSPACE_BLOCK_TYPES as readonly DashboardAiWorkspaceBlockType[]);
  const source = optionalEnum(raw.source, ['overview', 'seasonCatalog', 'resolvedDataRequest', 'multiSeason'] as const);
  if (!type || !source) return null;

  const block: DashboardAiWorkspaceBlock = {
    id: sanitizeBlockId(raw.id, `block-${index + 1}`),
    type,
    title: sanitizeVisualText(raw.title, workspaceBlockTitle(type), 80),
    source,
  };

  if (type === 'chart') {
    const chart = sanitizeDashboardAiChartSpec(raw.chart, source, block.title);
    if (!chart) return null;
    block.chart = chart;
    return block;
  }

  if (type === 'table') {
    const table = sanitizeDashboardAiTableSpec(raw.table, source, block.title);
    if (!table) return null;
    block.table = table;
    return block;
  }

  if (type === 'insight-list' || type === 'data-quality-notes') {
    const insights = sanitizeVisualTextList(raw.insights ?? raw.notes, DASHBOARD_VISUAL_REPORT_LIMITS.maxInsights);
    if (insights.length === 0) return null;
    block.insights = insights;
    return block;
  }

  if (type === 'rich-markdown') {
    const content = sanitizeDashboardAiRichMarkdown(raw.markdown ?? raw.content);
    if (!content) return null;
    block.markdown = { content };
    return block;
  }

  if (type === 'html-preview') {
    const htmlPreview = sanitizeDashboardAiHtmlPreview(raw.htmlPreview ?? raw.html ?? raw.content);
    if (!htmlPreview) return null;
    block.htmlPreview = htmlPreview;
    return block;
  }

  return block;
}

function sanitizeDashboardAiChartSpec(
  value: unknown,
  fallbackSource: DashboardAiWorkspaceBlockSource,
  fallbackTitle: string
): DashboardAiChartSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const chartType = optionalEnum(raw.chartType, DASHBOARD_AI_WORKSPACE_CHART_TYPES as readonly DashboardAiWorkspaceChartType[]);
  const source = optionalEnum(raw.source, ['overview', 'seasonCatalog', 'resolvedDataRequest', 'multiSeason'] as const) || fallbackSource;
  if (!chartType) return null;
  const series = Array.isArray(raw.series)
    ? raw.series
        .slice(0, DASHBOARD_AI_WORKSPACE_LIMITS.maxSeries)
        .map((entry) => sanitizeBlockId(entry, ''))
        .filter(Boolean)
    : [];
  const sourceQueryId = sanitizeBlockId(raw.sourceQueryId, '');
  const x = sanitizeBlockId(raw.x, '');
  const stackBy = sanitizeBlockId(raw.stackBy, '');
  const colorBy = sanitizeBlockId(raw.colorBy, '');
  const rows = sanitizeQueryRows(raw.rows, []);
  const limit = optionalPositiveInteger(raw.limit, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlockLimit);
  return {
    chartType,
    title: sanitizeVisualText(raw.title, fallbackTitle, 80),
    source,
    filters: sanitizeWorkspaceFilters(raw.filters),
    series,
    ...(sourceQueryId ? { sourceQueryId } : {}),
    ...(x ? { x } : {}),
    ...(stackBy ? { stackBy } : {}),
    ...(colorBy ? { colorBy } : {}),
    ...(rows.length ? { rows } : {}),
    ...(limit ? { limit } : {}),
  };
}

function sanitizeDashboardAiTableSpec(
  value: unknown,
  fallbackSource: DashboardAiWorkspaceBlockSource,
  fallbackTitle: string
): DashboardAiTableSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const templateId = optionalEnum(raw.templateId, DASHBOARD_AI_WORKSPACE_TABLE_TEMPLATE_IDS as readonly DashboardAiWorkspaceTableTemplateId[]);
  const source = optionalEnum(raw.source, ['overview', 'seasonCatalog', 'resolvedDataRequest', 'multiSeason'] as const) || fallbackSource;
  const tableData = sanitizeQueryTableData(raw.rows, raw.columns);
  if (!templateId && tableData.rows.length === 0) return null;
  const sourceQueryId = sanitizeBlockId(raw.sourceQueryId, '');
  const limit = optionalPositiveInteger(raw.limit, DASHBOARD_AI_WORKSPACE_LIMITS.maxBlockLimit);
  return {
    templateId: templateId || 'custom-table',
    title: sanitizeVisualText(raw.title, fallbackTitle, 80),
    columns: tableData.columns,
    source,
    filters: sanitizeWorkspaceFilters(raw.filters),
    ...(sourceQueryId ? { sourceQueryId } : {}),
    ...(tableData.rows.length ? { rows: tableData.rows } : {}),
    ...(limit ? { limit } : {}),
  };
}

function sanitizeDashboardAiRichMarkdown(value: unknown): string {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).content
    : value;
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, 8000);
}

function sanitizeDashboardAiHtmlPreview(value: unknown): DashboardAiHtmlPreviewSpec | null {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).html
    : value;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const cleaned = raw
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
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, 12000);
  if (!cleaned) {
    return {
      html: '<div>HTML preview Ä‘Ã£ bá»‹ tá»« chá»‘i vÃ¬ khÃ´ng cÃ²n ná»™i dung an toÃ n sau khi sanitize.</div>',
      sanitized: true, 
      rejectedReason: 'rejected_unsafe_render: HTML preview không còn nội dung an toàn sau khi sanitize.', 
    };
  }
  return {
    html: cleaned, 
    sanitized: cleaned !== raw, 
    ...(cleaned !== raw ? { rejectedReason: 'rejected_unsafe_render: Đã loại bỏ script, form, iframe, event handler hoặc external resource không an toàn.' } : {}), 
  }; 
} 

function sanitizeWorkspaceFilters(value: unknown): DashboardAiWorkspaceBlockFilters {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const comparisonMode = optionalEnum(raw.comparisonMode, ['mom', 'wow'] as const);
  const metric = optionalEnum(raw.metric, ['flights', 'pax'] as const);
  const typeFilter = optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const);
  const dimension = optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const);
  const timeBasis = optionalEnum(raw.timeBasis, ['local', 'utc'] as const);
  const currentPeriod = optionalPeriodFilter(raw.currentPeriod);
  const previousPeriod = optionalPeriodFilter(raw.previousPeriod);
  const currentMonth = optionalMonthNumberFilter(raw.currentMonth);
  const previousMonth = optionalMonthNumberFilter(raw.previousMonth);
  return {
    ...(comparisonMode ? { comparisonMode } : {}),
    ...(metric ? { metric } : {}),
    ...(typeFilter ? { typeFilter } : {}),
    ...(dimension ? { dimension } : {}),
    ...(timeBasis ? { timeBasis } : {}),
    ...(currentPeriod ? { currentPeriod } : {}),
    ...(previousPeriod ? { previousPeriod } : {}),
    ...(currentMonth ? { currentMonth } : {}),
    ...(previousMonth ? { previousMonth } : {}),
  };
}

function workspaceBlockTitle(type: DashboardAiWorkspaceBlockType): string {
  if (type === 'kpi') return 'KPI Strip';
  if (type === 'table') return 'Report Table';
  if (type === 'chart') return 'Report Chart';
  if (type === 'data-quality-notes') return 'Data Quality Notes';
  if (type === 'rich-markdown') return 'Rich Markdown';
  if (type === 'html-preview') return 'Sandbox HTML Preview';
  return 'Insights';
}

function optionalPeriodFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return isMonthKey(normalized) || isWeekKey(normalized) ? normalized : null;
}

function optionalMonthNumberFilter(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const month = Number(value);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? String(month).padStart(2, '0') : null;
}

function visualBlockTitle(type: DashboardVisualReportBlockType): string {
  if (type === 'kpi-summary') return 'KPI Summary';
  if (type === 'monthly-trend') return 'Monthly Trend';
  if (type === 'driver-waterfall') return 'Driver Waterfall';
  if (type === 'peak-hour') return 'Peak Hour';
  if (type === 'route-country-ranking') return 'Route Country Ranking';
  if (type === 'airline-mix-ranking') return 'Airline Mix Ranking';
  return 'Insight Notes';
}

function sanitizeBlockId(value: unknown, fallback: string): string {
  const normalized = sanitizeVisualText(value, fallback, 60)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || fallback;
}

function sanitizeVisualTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((entry) => escapeFormulaLike(sanitizeVisualText(entry, '', DASHBOARD_VISUAL_REPORT_LIMITS.maxTextChars)))
    .filter(Boolean);
}

function sanitizeVisualText(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return normalized || fallback;
}

function escapeFormulaLike(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function buildSeasonCatalog(input: {
  records: FlightRecord[];
  routeCountries?: RouteCountryMapping[];
  maxRows: number;
}): DashboardAiSeasonCatalog {
  const sorted = input.records
    .filter((record) => record.status !== 'deleted')
    .sort((left, right) => getDashboardOperationalDate(left).localeCompare(getDashboardOperationalDate(right)) || left.schedule.localeCompare(right.schedule));
  const dates = sorted.map((record) => getDashboardOperationalDate(record)).filter(Boolean);
  const maxRows = Math.max(1, input.maxRows);
  const topAirlines = summarizeBy(sorted, (record) => record.airline || 'Unknown', (key) => key).slice(0, maxRows);
  const topRoutes = summarizeBy(sorted, (record) => record.route || 'Unknown', (key) => key).slice(0, maxRows);
  const topCountries = summarizeBy(sorted, (record) => resolveCountryForRoute(record.route, input.routeCountries), (key) => key).slice(0, maxRows);
  const topAircraft = summarizeBy(sorted, (record) => record.aircraft || 'Unknown', (key) => key).slice(0, maxRows);
  return {
    totalRecords: sorted.length,
    dateRange: {
      from: dates[0] ?? '',
      to: dates[dates.length - 1] ?? '',
    },
    months: summarizeBy(sorted, (record) => monthKey(getDashboardOperationalDate(record)), (key) => periodLabel(key, 'mom')),
    weeks: summarizeBy(sorted, (record) => isoWeekKey(getDashboardOperationalDate(record)), (key) => periodLabel(key, 'wow')),
    typeTotals: summarizeBy(sorted, (record) => record.type, (key) => key === 'A' ? 'ARR' : 'DEP'),
    topAirlines,
    topRoutes,
    topCountries,
    topAircraft,
    truncated: {
      topRows: [topAirlines, topRoutes, topCountries, topAircraft].some((rows) => rows.length >= maxRows),
    },
  };
}

function matchesDataRequest(
  record: FlightRecord,
  request: DashboardAiDataRequest,
  routeCountries?: RouteCountryMapping[]
): boolean {
  const operationalDate = getDashboardOperationalDate(record);
  if (request.dateFrom && operationalDate < request.dateFrom) return false;
  if (request.dateTo && operationalDate > request.dateTo) return false;
  if (request.months?.length && !request.months.includes(monthKey(operationalDate))) return false;
  if (request.weeks?.length && !request.weeks.includes(isoWeekKey(operationalDate))) return false;
  if (request.typeFilter && request.typeFilter !== 'all' && record.type !== request.typeFilter) return false;
  if (request.airlines?.length && !request.airlines.includes(record.airline)) return false;
  if (request.routes?.length && !request.routes.includes(record.route)) return false;
  if (request.countries?.length && !request.countries.includes(resolveCountryForRoute(record.route, routeCountries))) return false;
  if (request.aircraft?.length && !request.aircraft.includes(record.aircraft)) return false;
  return true;
}

function summarizeBy(
  records: FlightRecord[],
  keyForRecord: (record: FlightRecord) => string,
  labelForKey: (key: string) => string,
  metric: DashboardMetric = 'flights'
): DashboardAiSummaryRow[] {
  const groups = new Map<string, DashboardAiSummaryRow>();
  for (const record of records) {
    const key = keyForRecord(record) || 'Unknown';
    const current = groups.get(key) ?? emptySummaryRow(key, labelForKey(key));
    current.recordCount += 1;
    current.flights += 1;
    current.pax += recordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => {
    const leftValue = metric === 'pax' ? left.pax : left.flights;
    const rightValue = metric === 'pax' ? right.pax : right.flights;
    return rightValue - leftValue || left.key.localeCompare(right.key);
  });
}

function summarizeRecords(key: string, label: string, records: FlightRecord[]): DashboardAiSummaryRow {
  const row = emptySummaryRow(key, label);
  for (const record of records) {
    row.recordCount += 1;
    row.flights += 1;
    row.pax += recordPax(record);
    if (record.type === 'A') row.arrivals += 1;
    if (record.type === 'D') row.departures += 1;
  }
  return row;
}

function emptySummaryRow(key: string, label: string): DashboardAiSummaryRow {
  return {
    key,
    label,
    flights: 0,
    pax: 0,
    arrivals: 0,
    departures: 0,
    recordCount: 0,
  };
}

function dimensionKey(
  record: FlightRecord,
  dimension: DashboardDimension,
  timeBasis: DashboardTimeBasis,
  routeCountries?: RouteCountryMapping[]
): string {
  if (dimension === 'airline') return record.airline || 'Unknown';
  if (dimension === 'route') return record.route || 'Unknown';
  if (dimension === 'country') return resolveCountryForRoute(record.route, routeCountries);
  if (dimension === 'aircraft') return record.aircraft || 'Unknown';
  if (dimension === 'type') return record.type;
  if (dimension === 'dayOfWeek') return weekdayLabel(getDashboardOperationalDate(record));
  if (dimension === 'hourBucket') return hourBucket(record.schedule, timeBasis);
  return record.flightNumber || record.rawFlightNumber || 'Unknown';
}

function recordPax(record: FlightRecord): number {
  return Number.isFinite(record.pax) ? Number(record.pax) : 0;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
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

function periodLabel(key: string, mode: DashboardComparisonMode): string {
  if (mode === 'wow') {
    const match = /^(\d{4})-W(\d{2})$/.exec(key);
    return match ? `Week ${Number(match[2])} ${match[1]}` : key;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const month = Number(match[2]) - 1;
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthLabels[month] ?? match[2]} ${match[1]}`;
}

function weekdayLabel(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return 'Unknown';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()];
}

function hourBucket(schedule: string, timeBasis: DashboardTimeBasis): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!match) return 'Unknown';
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (!Number.isFinite(minutes)) return 'Unknown';
  const shifted = timeBasis === 'utc' ? (minutes - 420 + 1440) % 1440 : minutes;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:00`;
}

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function optionalIsoDate(value: unknown): string | false | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseIsoDate(value)) return false;
  return value;
}

function optionalKeyList(value: unknown, validator: (entry: string) => boolean): string[] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  const list = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean);
  if (list.length > 24 || !list.every(validator)) return false;
  return [...new Set(list)];
}

function optionalTextList(value: unknown, options: { uppercase?: boolean } = {}): string[] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  const list = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean)
    .map((entry) => options.uppercase ? entry.toUpperCase() : entry)
    .slice(0, 40);
  return [...new Set(list)];
}

function optionalEnum<T extends readonly string[]>(value: unknown, allowed: T): T[number] | false | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T[number] : false;
}

function optionalPositiveInteger(value: unknown, cap: number): number | false | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return false;
  return Math.min(value, cap);
}

function isMonthKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isWeekKey(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return false;
  const week = Number(match[2]);
  return week >= 1 && week <= 53;
}

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const error = root.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, string>).message;
  }
  return typeof root.message === 'string' ? root.message : null;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length;
}

function toAiSelectedRecord(record: FlightRecord): DashboardAiSelectedRecord {
  return {
    id: record.id,
    date: record.date,
    type: record.type,
    airline: record.airline,
    flightNumber: record.flightNumber,
    rawFlightNumber: record.rawFlightNumber,
    route: record.route,
    schedule: record.schedule,
    aircraft: record.aircraft,
    pax: record.pax,
  };
}

function buildEmptyComparison(filters: DashboardAiFilters): DashboardComparisonResult {
  return {
    mode: filters.comparisonMode,
    granularity: 'month',
    metric: filters.metric,
    dimension: filters.dimension,
    typeFilter: filters.typeFilter,
    timeBasis: filters.timeBasis,
    status: 'empty',
    current: { key: '', label: '', total: 0, recordCount: 0 },
    previous: { key: '', label: '', total: 0, recordCount: 0 },
    delta: 0,
    deltaPct: null,
    periodLabels: { current: '', previous: '' },
    drivers: [],
  };
}



