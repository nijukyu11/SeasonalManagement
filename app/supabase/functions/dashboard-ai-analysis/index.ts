import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import {
  DASHBOARD_AI_QUERY_GROUP_BY_COLUMNS,
  DASHBOARD_AI_QUERY_LIMIT_CAP,
  DASHBOARD_AI_QUERY_METRICS,
  DASHBOARD_AI_QUERY_ORDER_COLUMNS,
  DASHBOARD_AI_PAX_STATUSES,
  DASHBOARD_AI_REPORTING_VIEWS,
  isDashboardAiQueryIntentPrompt,
  type DashboardAiDataQuery,
  type DashboardAiQueryCell,
  type DashboardAiQueryMetric,
  type DashboardAiQueryResult,
  type DashboardAiReportingView,
  type DashboardAiToolName,
} from '../_shared/dashboardAiShared.ts';

type AiProvider = 'gemini' | 'openai-compatible' | 'deepseek';
type AiToolName = DashboardAiToolName;
type AiReportTemplateId = 'mom-wow-analysis' | 'sanluong-summary';
type AiVisualReportTemplateId = 'season-overview' | 'driver-waterfall' | 'peak-hour' | 'route-country' | 'airline-mix';
type AiVisualReportBlockType = 'kpi-summary' | 'monthly-trend' | 'driver-waterfall' | 'peak-hour' | 'route-country-ranking' | 'airline-mix-ranking' | 'insight-notes';
type AiVisualReportBlockSource = 'seasonCatalog' | 'resolvedDataRequest';
type AiWorkspaceBlockType = 'kpi' | 'table' | 'chart' | 'insight-list' | 'data-quality-notes' | 'rich-markdown' | 'html-preview';
type AiWorkspaceBlockSource = AiVisualReportBlockSource | 'multiSeason';
type AiWorkspaceChartType = 'bar-ranking' | 'line-trend' | 'waterfall' | 'heatmap' | 'kpi-strip' | 'stacked-bar' | 'area' | 'pie';
type AiWorkspaceTableTemplateId = 'season-summary' | 'monthly-trend' | 'airline-ranking' | 'route-country-ranking' | 'peak-hour' | 'multi-season-summary' | 'custom-table';
type AiToolTraceStatus = 'accepted' | 'rejected' | 'executed' | 'skipped';
type AiToolTracePhase = 'generated_sql' | 'validated_sql' | 'executed_local_sql' | 'profiled_query_result' | 'verified_answer' | 'rendered_rich_chat' | 'rendered_sandbox_html' | 'rejected_unsafe_render';
type AiToolset = 'dashboard-readonly' | 'dashboard-visual' | 'dashboard-export' | 'dashboard-memory';
type AiContextProfile = 'overview' | 'peak-hour' | 'route-country' | 'airline-mix' | 'season-overview' | 'multi-season' | 'validated-sql' | 'eda-profile' | 'data-quality' | 'visualization' | 'answer-verification' | 'safe-rendering';
type AiDataSourcePolicy = 'local-sqlite' | 'supabase-reporting' | 'mixed';
type AiReportingView = DashboardAiReportingView;
type AiQueryMetric = DashboardAiQueryMetric;
type AiQueryCell = DashboardAiQueryCell;
type AiDataRequestDimension = 'airline' | 'route' | 'country' | 'aircraft' | 'type' | 'dayOfWeek' | 'hourBucket' | 'flightNumber';
type DashboardSupabaseClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => unknown;
};
type DashboardRpcResponse = { data: unknown; error: { message: string } | null };

interface AiModelSetting {
  id: string;
  label: string;
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
}

interface OperationalSettingsAiRow {
  ai_enabled: boolean | null;
  ai_active_model_id: string | null;
}

interface OperationalAiModelRow {
  id: string;
  label: string | null;
  provider: string | null;
  model: string | null;
  base_url: string | null;
  enabled: boolean | null;
}

interface OperationalAiContextDocumentRow {
  id: string;
  kind: 'rule' | 'skill' | null;
  title: string | null;
  content_md: string | null;
  enabled: boolean | null;
  sort_order: number | null;
}

interface AiContextDocument {
  id: string;
  kind: 'rule' | 'skill';
  title: string;
  contentMd: string;
  enabled: boolean;
  sortOrder: number;
}

interface AiRequestBody {
  userPrompt?: string;
  context?: unknown;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  modelId?: string;
  allowedExportActions?: Array<'mom-wow-analysis.xlsx' | 'sanluong-summary.xlsx'>;
  allowedTools?: AiToolName[];
  availableTools?: Array<Record<string, unknown>>;
  preferredTool?: AiToolName;
  selectedSkillId?: string;
  contextProfile?: AiContextProfile;
  notebookContext?: unknown;
  language?: 'vi';
  providerFallback?: boolean;
  allowedReportTemplates?: AiReportTemplateId[];
  allowedVisualReports?: AiVisualReportTemplateId[];
  maxRounds?: number;
  allowDataRequest?: boolean;
  allowCustomWorkbook?: boolean;
  aiContextDocuments?: AiContextDocument[];
}

type ValidAiRequestBody = AiRequestBody & { userPrompt: string; context: unknown };

type AiDataQuery = DashboardAiDataQuery;
type AiQueryResult = DashboardAiQueryResult;

interface AiDataRequest {
  type: 'dashboard-data-request';
  scope: 'records' | 'summary' | 'comparison';
  dateFrom?: string;
  dateTo?: string;
  months?: string[];
  weeks?: string[];
  typeFilter?: 'all' | 'A' | 'D';
  airlines?: string[];
  routes?: string[];
  countries?: string[];
  aircraft?: string[];
  metric?: 'flights' | 'pax';
  dimension?: AiDataRequestDimension;
  maxRecords?: number;
}

interface AiTemplateExportAction {
  type: 'dashboard-template-export';
  templateId: 'mom-wow-analysis' | 'sanluong-summary';
  format: 'xlsx';
  fileName: 'mom-wow-analysis.xlsx' | 'sanluong-summary.xlsx';
}

interface AiCustomWorkbookAction {
  type: 'dashboard-custom-workbook';
  format: 'xlsx';
  fileName?: string;
  workbookSpec: unknown;
}

type AiExportAction = AiTemplateExportAction | AiCustomWorkbookAction;

interface AiVisualReportBlock {
  id: string;
  type: AiVisualReportBlockType;
  title: string;
  source: AiVisualReportBlockSource;
  metric?: 'flights' | 'pax';
  dimension?: AiDataRequestDimension;
  limit?: number;
}

interface AiVisualReport {
  templateId: AiVisualReportTemplateId;
  title: string;
  filters: {
    comparisonMode: 'mom' | 'wow';
    metric: 'flights' | 'pax';
    typeFilter: 'all' | 'A' | 'D';
    dimension: AiDataRequestDimension;
    timeBasis: 'local' | 'utc';
  };
  blocks: AiVisualReportBlock[];
  insights: string[];
  dataQualityNotes: string[];
}

interface AiToolTraceEntry {
  tool: AiToolName;
  status: AiToolTraceStatus;
  reason: string;
  phase?: AiToolTracePhase;
  skill?: string;
  toolset?: AiToolset;
  fallbackReason?: string;
  contextProfile?: AiContextProfile;
  providerAttempt?: number;
}

interface AiSqlQueryPlan {
  queryId: string;
  sql: string;
  params: AiQueryCell[];
  reasonVi: string;
  expectedColumns: string[];
  visualizationHint: AiWorkspaceChartType | 'table';
  source: AiDataSourcePolicy;
}

interface AiWorkspaceChartSpec {
  chartType: AiWorkspaceChartType;
  title: string;
  source: AiWorkspaceBlockSource;
  filters: Record<string, string>;
  series: string[];
  limit?: number;
  sourceQueryId?: string;
  x?: string;
  stackBy?: string;
  colorBy?: string;
  rows?: Record<string, AiQueryCell>[];
}

interface AiWorkspaceTableSpec {
  templateId?: AiWorkspaceTableTemplateId;
  title: string;
  columns: string[];
  source: AiWorkspaceBlockSource;
  filters: Record<string, string>;
  limit?: number;
  sourceQueryId?: string;
  rows?: Record<string, AiQueryCell>[];
}

interface AiRichMarkdownSpec {
  content: string;
}

interface AiHtmlPreviewSpec {
  html: string;
  sanitized: boolean;
  rejectedReason?: string;
}

interface AiWorkspaceBlock {
  id: string;
  type: AiWorkspaceBlockType;
  title: string;
  source: AiWorkspaceBlockSource;
  chart?: AiWorkspaceChartSpec;
  table?: AiWorkspaceTableSpec;
  markdown?: AiRichMarkdownSpec;
  htmlPreview?: AiHtmlPreviewSpec;
  insights?: string[];
}

interface AiBoardPatch {
  title: string;
  blocks: AiWorkspaceBlock[];
  append: boolean;
}

interface AssistantStructuredPayload {
  assistantText?: string;
  dataRequest?: unknown;
  dataQuery?: unknown;
  dataQueries?: unknown;
  queryResults?: unknown;
  sqlQueryPlans?: unknown;
  exportAction?: unknown;
  visualReport?: unknown;
  boardPatch?: unknown;
  toolTraceSummary?: unknown;
}

interface AiAgentAnalysisResult {
  providerText: string;
  structured: AssistantStructuredPayload | null;
  queryResults: AiQueryResult[];
}

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

interface GeminiContentPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  thoughtSignature?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: GeminiContentPart[] } }>;
}

type GeminiLlmResult =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: { name: AiToolName; args: Record<string, unknown> }; modelPart: GeminiContentPart };

interface OpenAiCompatibleResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const DASHBOARD_AI_GROUNDING_INSTRUCTIONS = [
  'You are an aviation operations analyst for the Seasonal Management dashboard.',
  'Answer only from Supabase reporting queryResults, result profiles, and the supplied season catalog context.',
  'Luôn trả lời bằng tiếng Việt cho mọi nội dung người dùng nhìn thấy.',
  'If the supplied data is insufficient, say what is missing instead of inventing a cause.',
  'Reference exact periods, filters, deltas, drivers, and record examples when relevant.',
  'Avoid generic aviation explanations that are not supported by the provided data.',
      'The context may include a seasonCatalog, selectedSeasonCatalog, dataQueries, and queryResults from reporting RPCs.',
      'If the user asks for historical or cross-month data that is not present in queryResults, return dataQueries instead of guessing.',
      'For spreadsheet needs, return a dashboard-custom-workbook spec built from queryResults/custom rows.',
      'When returning actions, use a single JSON object with assistantText plus optional dataQueries, exportAction, visualReport, or boardPatch.',
  'Dùng văn phong vận hành tiếng Việt ngắn gọn; giữ nguyên ARR/DEP, MoM/WoW, KPI, airline code và route code.',
].join('\n');

const DEFAULT_AI_MODELS: AiModelSetting[] = [
  {
    id: 'gemini-flash',
    label: 'Gemini Flash',
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    baseUrl: null,
    enabled: true,
  },
  {
    id: 'qwen-plus',
    label: 'Qwen Plus',
    provider: 'openai-compatible',
    model: 'qwen-plus',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    enabled: true,
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    enabled: true,
  },
];

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const FUNCTION_NAME = 'dashboard-ai-analysis';
const DEFAULT_ALLOWED_TOOLS: AiToolName[] = ['query_dashboard_data', 'suggest_custom_workbook', 'suggest_visual_report', 'compose_dashboard_ai_board'];
const DEFAULT_ALLOWED_REPORT_TEMPLATES: AiReportTemplateId[] = ['mom-wow-analysis', 'sanluong-summary'];
const DEFAULT_ALLOWED_VISUAL_REPORTS: AiVisualReportTemplateId[] = ['season-overview', 'driver-waterfall', 'peak-hour', 'route-country', 'airline-mix'];
const VISUAL_BLOCK_TYPES: AiVisualReportBlockType[] = ['kpi-summary', 'monthly-trend', 'driver-waterfall', 'peak-hour', 'route-country-ranking', 'airline-mix-ranking', 'insight-notes'];
const VISUAL_BLOCK_SOURCES: AiVisualReportBlockSource[] = ['seasonCatalog', 'resolvedDataRequest'];
const WORKSPACE_BLOCK_TYPES: AiWorkspaceBlockType[] = ['kpi', 'table', 'chart', 'insight-list', 'data-quality-notes', 'rich-markdown', 'html-preview'];
const WORKSPACE_BLOCK_SOURCES: AiWorkspaceBlockSource[] = ['seasonCatalog', 'resolvedDataRequest', 'multiSeason'];
const WORKSPACE_CHART_TYPES: AiWorkspaceChartType[] = ['bar-ranking', 'line-trend', 'waterfall', 'heatmap', 'kpi-strip', 'stacked-bar', 'area', 'pie'];
const WORKSPACE_TABLE_TEMPLATES: AiWorkspaceTableTemplateId[] = ['season-summary', 'monthly-trend', 'airline-ranking', 'route-country-ranking', 'peak-hour', 'multi-season-summary', 'custom-table'];
const TOOL_TRACE_STATUSES: AiToolTraceStatus[] = ['accepted', 'rejected', 'executed', 'skipped'];
const REPORTING_VIEWS: AiReportingView[] = [...DASHBOARD_AI_REPORTING_VIEWS];
const QUERY_METRICS: AiQueryMetric[] = [...DASHBOARD_AI_QUERY_METRICS];
const QUERY_GROUP_BY_COLUMNS = [...DASHBOARD_AI_QUERY_GROUP_BY_COLUMNS];
const QUERY_ORDER_COLUMNS = [...DASHBOARD_AI_QUERY_ORDER_COLUMNS];
const QUERY_LIMIT_CAP = DASHBOARD_AI_QUERY_LIMIT_CAP;
const NORMALIZED_QUERY_COLUMNS = new Set<string>([
  ...QUERY_GROUP_BY_COLUMNS,
  ...QUERY_ORDER_COLUMNS,
]);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const { data: operator, error: operatorError } = await supabase
      .from('app_operators')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (operatorError) return jsonResponse({ error: operatorError.message }, 500);
    if (!operator) return jsonResponse({ error: 'Operator access required' }, 403);

    const body = await req.json() as AiRequestBody;
    if (!body.userPrompt?.trim()) return jsonResponse({ error: 'Prompt is required' }, 400);
    if (!body.context) return jsonResponse({ error: 'Dashboard context is required' }, 400);

    const [settingsResult, modelRowsResult, contextDocumentRowsResult] = await Promise.all([
      supabase
        .from('operational_settings')
        .select('ai_enabled,ai_active_model_id')
        .eq('id', 'operational')
        .maybeSingle(),
      supabase
        .from('operational_ai_models')
        .select('id,label,provider,model,base_url,enabled')
        .order('sort_order', { ascending: true }),
      supabase
        .from('operational_ai_context_documents')
        .select('id,kind,title,content_md,enabled,sort_order')
        .eq('enabled', true)
        .order('sort_order', { ascending: true }),
    ]);
    if (settingsResult.error) return jsonResponse({ error: settingsResult.error.message }, 500);
    if (modelRowsResult.error) return jsonResponse({ error: modelRowsResult.error.message }, 500);
    if (contextDocumentRowsResult.error) return jsonResponse({ error: contextDocumentRowsResult.error.message }, 500);
    const aiContextDocuments = sanitizeAiContextDocuments((contextDocumentRowsResult.data ?? []) as OperationalAiContextDocumentRow[]);
    const bodyWithContextDocuments: ValidAiRequestBody = {
      ...body,
      userPrompt: body.userPrompt.trim(),
      context: body.context,
      aiContextDocuments,
    };

    const model = resolveModel(
      buildRelationalAiSettingsPayload(
        settingsResult.data as OperationalSettingsAiRow | null,
        (modelRowsResult.data ?? []) as OperationalAiModelRow[]
      ),
      bodyWithContextDocuments.modelId
    );
    if (!model) return jsonResponse({ error: 'Requested AI model is not enabled' }, 400);

    let dataQueries: AiDataQuery[] = [];
    if (shouldAutoQueryDashboardData(bodyWithContextDocuments)) {
      const inferredQuery = inferDataQueryForPrompt(bodyWithContextDocuments.userPrompt, bodyWithContextDocuments.context);
      if (inferredQuery) dataQueries = [inferredQuery];
    }
    const history = (bodyWithContextDocuments.history ?? []).slice(-6);
    const analysis = model.provider === 'gemini'
      ? await runGeminiAgentAnalysis(supabase, model, bodyWithContextDocuments, history, dataQueries)
      : await runTextPromptAnalysis(supabase, model, bodyWithContextDocuments, history, dataQueries);
    const providerText = analysis.providerText;
    const structured = analysis.structured;
    const queryResults = analysis.queryResults;
    const sqlQueryPlans = sanitizeSqlQueryPlans(structured?.sqlQueryPlans, bodyWithContextDocuments);
    const dataRequest = bodyWithContextDocuments.allowDataRequest === false ? null : sanitizeDataRequest(structured?.dataRequest);
    const structuredExportAction = sanitizeExportAction(structured?.exportAction, bodyWithContextDocuments);
    const exportAction = structuredExportAction ?? inferExportAction(bodyWithContextDocuments.userPrompt, bodyWithContextDocuments.allowedExportActions);
    const visualReport = sanitizeVisualReport(structured?.visualReport, bodyWithContextDocuments);
    const providerBoardPatch = sanitizeBoardPatch(structured?.boardPatch, bodyWithContextDocuments);
    const queryBoardPatch = boardPatchFromQueryResults(queryResults, bodyWithContextDocuments.userPrompt, bodyWithContextDocuments);
    const preferQueryResults = shouldPreferQueryResults(bodyWithContextDocuments.userPrompt, queryResults, providerBoardPatch);
    const boardPatch = preferQueryResults
      ? queryBoardPatch ?? providerBoardPatch ?? inferBoardPatch(bodyWithContextDocuments.userPrompt, visualReport, bodyWithContextDocuments)
      : providerBoardPatch ?? queryBoardPatch ?? inferBoardPatch(bodyWithContextDocuments.userPrompt, visualReport, bodyWithContextDocuments);
    const staleBoardTrace: AiToolTraceEntry | null = preferQueryResults && providerBoardPatch && queryBoardPatch
      ? {
          tool: 'compose_dashboard_ai_board',
          status: 'rejected',
          reason: 'Bỏ qua boardPatch của provider vì prompt yêu cầu truy vấn dữ liệu và block không gắn sourceQueryId phù hợp.',
          toolset: 'dashboard-visual',
          fallbackReason: 'Ưu tiên queryResults cho query-first notebook.',
        }
      : null;
    const customContextTrace = buildCustomContextTrace(aiContextDocuments);
    const toolTraceSummary = sanitizeToolTraceSummary(structured?.toolTraceSummary, bodyWithContextDocuments, {
      queryResults,
      dataRequest,
      exportAction,
      visualReport,
      boardPatch,
    }).concat(staleBoardTrace ? [staleBoardTrace] : [], customContextTrace ? [customContextTrace] : []).slice(0, 8);
    const assistantText = (structured?.assistantText?.trim() || providerText).trim();

    return jsonResponse({
      assistantText,
      modelId: model.id,
      functionName: FUNCTION_NAME,
      ...(queryResults.length ? { queryResults } : {}),
      ...(sqlQueryPlans.length ? { sqlQueryPlans } : {}),
      ...(dataRequest ? { dataRequest } : {}),
      ...(exportAction ? { exportAction } : {}),
      ...(visualReport ? { visualReport } : {}),
      ...(boardPatch ? { boardPatch } : {}),
      ...(toolTraceSummary.length ? { toolTraceSummary } : {}),
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'AI analysis failed' }, 500);
  }
});

async function runTextPromptAnalysis(
  supabase: DashboardSupabaseClient,
  model: AiModelSetting,
  body: ValidAiRequestBody,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  initialDataQueries: AiDataQuery[]
): Promise<AiAgentAnalysisResult> {
  const initialQueryResults = await resolveDashboardDataQueries(supabase, initialDataQueries);
  const prompt = buildDashboardAiPrompt(body.userPrompt, mergeContextWithQueryResults(body.context, initialQueryResults), body);
  let providerText = await callOpenAiCompatible(model, prompt, history);
  let structured = parseStructuredAssistantPayload(providerText);
  const providerDataQueries = sanitizeDataQueries(structured?.dataQueries ?? structured?.dataQuery);
  const providerQueryResults = providerDataQueries.length > 0 ? await resolveDashboardDataQueries(supabase, providerDataQueries) : [];
  const queryResults = mergeQueryResults(initialQueryResults, providerQueryResults);
  if (queryResults.length > 0 && !structured?.boardPatch) {
    const followUpPrompt = buildDashboardAiPrompt(body.userPrompt, mergeContextWithQueryResults(body.context, queryResults), {
      ...body,
      allowDataRequest: false,
    });
    const followUpText = await callOpenAiCompatible(model, followUpPrompt, [...history, { role: 'assistant', content: providerText }]);
    const followUpStructured = parseStructuredAssistantPayload(followUpText);
    if (followUpStructured) {
      providerText = followUpText;
      structured = followUpStructured;
    }
  }
  return { providerText, structured, queryResults };
}

async function runGeminiAgentAnalysis(
  supabase: DashboardSupabaseClient,
  model: AiModelSetting,
  body: ValidAiRequestBody,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  initialDataQueries: AiDataQuery[]
): Promise<AiAgentAnalysisResult> {
  const maxRounds = resolveAgentMaxRounds(body.maxRounds);
  let queryResults = await resolveDashboardDataQueries(supabase, initialDataQueries);
  const prompt = buildDashboardAiPrompt(body.userPrompt, mergeContextWithQueryResults(body.context, queryResults), body);
  const toolDeclarations = buildToolDeclarations(body);
  const toolContents: GeminiContent[] = [];
  let providerText = '';
  let structured: AssistantStructuredPayload | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    const result = await callGemini(model, prompt, history, toolDeclarations, toolContents);
    if (result.type === 'text') {
      providerText = result.text;
      structured = parseStructuredAssistantPayload(providerText);
      const providerDataQueries = sanitizeDataQueries(structured?.dataQueries ?? structured?.dataQuery);
      const providerQueryResults = providerDataQueries.length > 0 ? await resolveDashboardDataQueries(supabase, providerDataQueries) : [];
      queryResults = mergeQueryResults(queryResults, providerQueryResults);
      if (providerDataQueries.length > 0 && queryResults.length > 0 && !structured?.boardPatch && round < maxRounds) {
        const followUpPrompt = buildDashboardAiPrompt(body.userPrompt, mergeContextWithQueryResults(body.context, queryResults), {
          ...body,
          allowDataRequest: false,
        });
        const followUpResult = await callGemini(model, followUpPrompt, [...history, { role: 'assistant', content: providerText }]);
        if (followUpResult.type === 'text') {
          providerText = followUpResult.text;
          structured = parseStructuredAssistantPayload(providerText);
        }
      }
      break;
    }

    const toolResult = await executeGeminiToolCall(supabase, result.toolCall, body, round);
    if (result.toolCall.name === 'compose_dashboard_ai_board' && toolResult.terminalText) {
      providerText = toolResult.terminalText;
      structured = parseStructuredAssistantPayload(providerText);
      break;
    }
    queryResults = mergeQueryResults(queryResults, toolResult.queryResults);
    toolContents.push({
      role: 'model',
      parts: [result.modelPart],
    });
    toolContents.push({
      role: 'user',
      parts: [{ functionResponse: { name: result.toolCall.name, response: toolResult.response } }],
    });
  }

  if (!providerText) {
    const fallbackPatch = boardPatchFromQueryResults(queryResults, body.userPrompt, body) ?? inferBoardPatch(body.userPrompt, null, body);
    providerText = JSON.stringify({
      assistantText: queryResults.length > 0
        ? 'Đã truy vấn dữ liệu dashboard và tạo kết quả trực quan từ dữ liệu trả về.'
        : 'Tôi chưa đủ dữ liệu để trả lời chính xác. Vui lòng nêu rõ khoảng ngày, mùa, hãng bay, đường bay hoặc metric cần phân tích.',
      ...(fallbackPatch ? { boardPatch: fallbackPatch } : {}),
      toolTraceSummary: [{
        tool: 'query_dashboard_data',
        status: queryResults.length > 0 ? 'executed' : 'skipped',
        reason: queryResults.length > 0 ? 'Đã dùng kết quả truy vấn làm fallback khi hết vòng agent.' : 'Agent vượt giới hạn vòng gọi mà chưa có dữ liệu đủ rõ.',
        toolset: 'dashboard-readonly',
        providerAttempt: maxRounds,
      }],
    });
    structured = parseStructuredAssistantPayload(providerText);
  }

  return { providerText, structured, queryResults };
}

function mergeContextWithQueryResults(context: unknown, queryResults: AiQueryResult[]): unknown {
  if (queryResults.length === 0) return context;
  return {
    ...(context && typeof context === 'object' && !Array.isArray(context) ? context as Record<string, unknown> : { context }),
    queryResults,
  };
}

function resolveAgentMaxRounds(value: unknown): number {
  return Math.min(Math.max(typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 4, 1), 6);
}

function buildRelationalAiSettingsPayload(settingsRow: OperationalSettingsAiRow | null, modelRows: OperationalAiModelRow[]): Record<string, unknown> {
  const configuredModels = modelRows
    .map((row) => ({
      id: row.id,
      label: row.label ?? row.id,
      provider: row.provider === 'openai-compatible' || row.provider === 'deepseek' ? row.provider : 'gemini',
      model: row.model ?? '',
      baseUrl: row.base_url,
      enabled: row.enabled !== false,
    }))
    .filter((row) => row.id && row.model);
  return {
    aiAnalysis: {
      enabled: settingsRow?.ai_enabled !== false,
      activeModelId: settingsRow?.ai_active_model_id ?? configuredModels[0]?.id ?? DEFAULT_AI_MODELS[0].id,
      models: configuredModels.length > 0 ? configuredModels : DEFAULT_AI_MODELS,
    },
  };
}

function resolveModel(settingsPayload: unknown, requestedModelId?: string): AiModelSetting | null {
  const root = settingsPayload && typeof settingsPayload === 'object' ? settingsPayload as Record<string, unknown> : {};
  const aiAnalysis = root.aiAnalysis && typeof root.aiAnalysis === 'object' ? root.aiAnalysis as Record<string, unknown> : {};
  if (aiAnalysis.enabled === false) return null;
  const configuredModels = Array.isArray(aiAnalysis.models) ? aiAnalysis.models : DEFAULT_AI_MODELS;
  const models = configuredModels.map((model) => normalizeModel(model)).filter((model): model is AiModelSetting => model != null && model.enabled);
  const activeModelId = typeof aiAnalysis.activeModelId === 'string' ? aiAnalysis.activeModelId : DEFAULT_AI_MODELS[0].id;
  return models.find((model) => model.id === requestedModelId) ??
    models.find((model) => model.id === activeModelId) ??
    models[0] ??
    null;
}

function normalizeModel(value: unknown): AiModelSetting | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const provider: AiProvider = raw.provider === 'openai-compatible' || raw.provider === 'deepseek'
    ? raw.provider
    : 'gemini';
  const id = String(raw.id ?? '').trim();
  const model = String(raw.model ?? '').trim();
  if (!id || !model) return null;
  const baseUrl = provider !== 'gemini'
    ? String(raw.baseUrl ?? '').trim().replace(/\/+$/, '')
    : null;
  return {
    id,
    label: String(raw.label ?? id).trim(),
    provider,
    model,
    baseUrl: baseUrl || null,
    enabled: raw.enabled !== false,
  };
}

const CUSTOM_CONTEXT_MAX_CHARS = 24 * 1024;

function sanitizeAiContextDocuments(rows: OperationalAiContextDocumentRow[]): AiContextDocument[] {
  return rows
    .filter((row) => row.enabled !== false && (row.kind === 'rule' || row.kind === 'skill'))
    .sort((a, b) =>
      String(a.kind ?? '').localeCompare(String(b.kind ?? '')) ||
      Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
    )
    .slice(0, 20)
    .map((row, index) => ({
      id: row.id,
      kind: row.kind === 'skill' ? 'skill' : 'rule',
      title: String(row.title ?? row.id).trim() || row.id,
      contentMd: String(row.content_md ?? '').replace(/\u0000/g, '').slice(0, 64 * 1024),
      enabled: true,
      sortOrder: Number(row.sort_order ?? index),
    }));
}

function formatCustomMarkdownSections(documents: AiContextDocument[]): { rulesMd: string; skillsMd: string; truncated: boolean } {
  const sections = documents
    .filter((document) => document.enabled && document.contentMd.trim())
    .map((document) => ({
      kind: document.kind,
      markdown: `### ${document.title}\n${document.contentMd.trim()}`,
    }));
  let remaining = CUSTOM_CONTEXT_MAX_CHARS;
  let truncated = false;
  const rules: string[] = [];
  const skills: string[] = [];
  for (const section of sections) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = section.markdown.length > remaining ? section.markdown.slice(0, remaining) : section.markdown;
    if (text.length < section.markdown.length) truncated = true;
    if (section.kind === 'skill') skills.push(text);
    else rules.push(text);
    remaining -= text.length;
  }
  return {
    rulesMd: rules.length > 0 ? rules.join('\n\n') : 'none',
    skillsMd: skills.length > 0 ? skills.join('\n\n') : 'none',
    truncated,
  };
}

function buildCustomContextTrace(documents: AiContextDocument[]): AiToolTraceEntry | null {
  const formatted = formatCustomMarkdownSections(documents);
  if (!formatted.truncated) return null;
  return {
    tool: 'compose_dashboard_ai_board',
    status: 'executed',
    reason: 'Rules/Skills tuỳ chỉnh đã bị cắt bớt vì vượt giới hạn context 24KB.',
    toolset: 'dashboard-memory',
    fallbackReason: 'Giữ prompt trong giới hạn an toàn.',
  };
}

function buildDashboardAiPrompt(userPrompt: string, context: unknown, body: ValidAiRequestBody): string {
  const preferredTool = body.preferredTool;
  const allowDataRequest = body.allowDataRequest !== false;
  const language = body.language ?? 'vi';
  const availableTools = Array.isArray(body.availableTools) ? body.availableTools : DEFAULT_ALLOWED_TOOLS.map((tool) => ({ name: tool, availability: 'enabled' }));
  const customContext = formatCustomMarkdownSections(body.aiContextDocuments ?? []);
  return [
    'STABLE_AGENT_CONTRACT:',
    JSON.stringify({
      language,
      languagePolicy: 'Luôn trả lời bằng tiếng Việt. Giữ nguyên ARR/DEP, MoM/WoW, KPI, airline code, route code và internal tool/schema ids.',
      grounding: DASHBOARD_AI_GROUNDING_INSTRUCTIONS,
      toolsets: ['dashboard-readonly', 'dashboard-visual', 'dashboard-export', 'dashboard-memory'],
      availableTools,
      skills: [
        { id: 'month-comparison-drivers', descriptionVi: 'Phân rã biến động giữa hai tháng bằng queryResults theo hãng bay và đường bay.', contextProfile: 'validated-sql', preferredTool: 'query_dashboard_data' },
        { id: 'peak-hour-analysis', descriptionVi: 'Tạo biểu đồ và bảng khung giờ cao điểm.', contextProfile: 'peak-hour', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'route-country-report', descriptionVi: 'Tạo báo cáo đường bay/quốc gia.', contextProfile: 'route-country', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'airline-mix-report', descriptionVi: 'Tạo báo cáo cơ cấu hãng bay.', contextProfile: 'airline-mix', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'season-overview-report', descriptionVi: 'Tạo báo cáo tổng quan mùa.', contextProfile: 'season-overview', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'validated-sql-analyst', descriptionVi: 'Tạo dataQueries read-only qua Supabase reporting khi cần dữ liệu chi tiết.', contextProfile: 'validated-sql', preferredTool: 'query_dashboard_data' },
        { id: 'eda-profile', descriptionVi: 'Lập hồ sơ EDA: coverage, null/missing, distinct, min/max, top values và outlier.', contextProfile: 'eda-profile', preferredTool: 'query_dashboard_data' },
        { id: 'data-quality-audit', descriptionVi: 'Kiểm tra chất lượng dữ liệu, field thiếu, scope và truncation.', contextProfile: 'data-quality', preferredTool: 'query_dashboard_data' },
        { id: 'driver-decomposition', descriptionVi: 'Phân rã driver theo airline, route, local hour, ARR/DEP, country hoặc aircraft.', contextProfile: 'validated-sql', preferredTool: 'query_dashboard_data' },
        { id: 'visualization-grammar', descriptionVi: 'Chọn bảng, KPI và biểu đồ declarative phù hợp với dữ liệu truy vấn.', contextProfile: 'visualization', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'answer-verification', descriptionVi: 'Không nêu số liệu nếu không khớp query result/profile.', contextProfile: 'answer-verification', preferredTool: 'query_dashboard_data' },
        { id: 'safe-rendering-policy', descriptionVi: 'HTML preview chỉ là HTML/CSS tĩnh trong iframe sandbox; không script/Python.', contextProfile: 'safe-rendering', preferredTool: 'compose_dashboard_ai_board' },
        { id: 'supabase-reporting-safety', descriptionVi: 'Dùng Supabase reporting qua RPC allowlist và trả queryResults có sourceQueryId.', contextProfile: 'data-quality', preferredTool: 'query_dashboard_data' },
      ],
      safety: 'Read-only. Chỉ được đề xuất dataQueries qua Supabase reporting RPC allowlist; không sinh SQL/raw query, đường dẫn file hoặc thao tác ghi dữ liệu. Không chạy raw HTML/script/Python trong DOM chính; HTML chỉ được phép qua html-preview để app render HTML/CSS tĩnh trong iframe sandbox.',
    }, null, 2),
    '',
    'LANGUAGE_POLICY:',
    'language: vi',
    'assistantText, boardPatch titles, table/chart titles, insights, dataQualityNotes và toolTraceSummary.reason phải bằng tiếng Việt.',
    '',
    'CUSTOM_RULES_MD:',
    customContext.rulesMd,
    '',
    'CUSTOM_SKILLS_MD:',
    customContext.skillsMd,
    customContext.truncated ? '\nCUSTOM_CONTEXT_NOTE: Rules/Skills tuỳ chỉnh đã bị cắt bớt vì vượt giới hạn 24KB.' : '',
    '',
    `USER_PROMPT: ${userPrompt.trim()}`,
    '',
    'AGENT_RUNTIME:',
    [
      'ownerWorkflow: dashboard-report-analysis',
      'maxRounds: 4',
      'allowedTools: query_dashboard_data, suggest_custom_workbook, suggest_visual_report, compose_dashboard_ai_board',
      `preferredTool: ${preferredTool ?? 'none'}`,
      `selectedSkillId: ${body.selectedSkillId ?? 'none'}`,
      `contextProfile: ${body.contextProfile ?? 'none'}`,
      `allowDataQueries: ${allowDataRequest}`,
      'Tools are read-only. query_dashboard_data chạy qua Supabase reporting RPC allowlist bằng dataQueries và trả queryResults; không đề xuất ghi dữ liệu, SQL/raw query, script trong DOM, Python execution, external resources hoặc operational mutations.',
    ].join('\n'),
    '',
    'OUTPUT_CONTRACT:',
    [
      'Return normal text when queryResults/profile and seasonCatalog are sufficient.',
      'AI Workspace is query-only and independent from dashboard MoM/WoW state. If detailed rows are needed, return dataQueries for Supabase reporting; do not return legacy dataRequest or raw SQL plans.',
      'If queryResults already exist or additional queries are not allowed, produce the final analysis from queryResults/profile instead of asking for data again.',
      'Khi queryResults/profile đã có, chỉ nêu số liệu có trong query result/profile. Nếu chưa có bằng chứng, ghi chú thiếu dữ liệu thay vì suy đoán.',
      'Khi render HTML, chỉ trả HTML/CSS tĩnh trong html-preview; tuyệt đối không yêu cầu chạy Python, JavaScript, package runtime, network hoặc filesystem.',
      'If dashboard rows are needed, return dataQueries immediately. Example: {"assistantText":"Đang truy vấn dữ liệu phù hợp.","dataQueries":[{"queryId":"q1","view":"flight_operations","filters":{"months":["YYYY-MM"],"iataSeasonCodes":["S26"],"typeFilter":"all"},"groupBy":["route"],"metrics":["pax","flights"],"orderBy":"pax","limit":10}]}',
      'query_dashboard_data is read-only and may query only these views: flight_operations, summary_airline, summary_country, summary_route, summary_month, summary_week, summary_peak_hour, summary_aircraft, summary_arr_dep_mix. It can group/filter by isoweek, weeknum, local/UTC buckets, ac_group, and pax_status through allowlisted RPCs. Do not write SQL.',
      'If suggesting Excel, return dashboard-custom-workbook only, built from queryResults/custom rows. Do not suggest fixed MoM/WoW dashboard templates from AI Workspace.',
      'exportAction may be {"type":"dashboard-custom-workbook","format":"xlsx","fileName":"custom.xlsx","workbookSpec":{"title":"...","sheets":[{"name":"...","columns":["..."],"rows":[{"Column":"value"}]}]}}.',
      'For visual requests, prefer boardPatch backed by queryResults/sourceQueryId. visualReport may use metric/dimension filters only, without comparisonMode or MoM/WoW assumptions.',
      'For AI Workspace whiteboard requests, return boardPatch: {"title":"...","blocks":[{"id":"drivers","type":"table|chart|kpi|insight-list|data-quality-notes|rich-markdown|html-preview","title":"...","source":"seasonCatalog|resolvedDataRequest|multiSeason","markdown":{"content":"## Tóm tắt..."},"htmlPreview":{"html":"<section>...</section>"},"table":{"templateId":"season-summary|monthly-trend|airline-ranking|route-country-ranking|peak-hour|multi-season-summary|custom-table","columns":["label","flights"],"rows":[{"label":"VN","flights":10}],"sourceQueryId":"q1","source":"resolvedDataRequest","limit":12},"chart":{"chartType":"bar-ranking|line-trend|waterfall|heatmap|kpi-strip|stacked-bar|area|pie","sourceQueryId":"q1","x":"label","source":"resolvedDataRequest","series":["flights"],"rows":[{"label":"VN","flights":10}],"limit":12},"insights":["..."]}],"append":false}.',
      'HTML chỉ được dùng trong html-preview để app render bằng iframe sandbox; chỉ HTML/CSS tĩnh, không dùng script, Python, form, iframe con, object/embed, external script hoặc event handler.',
      'If preferredTool is compose_dashboard_ai_board, visual/table/chart output must include boardPatch; narrative text alone is not sufficient.',
      'When a tool is used, include toolTraceSummary with whitelisted tool/status/reason entries.',
    ].join('\n'),
    '',
    'EPHEMERAL_DASHBOARD_CONTEXT:',
    JSON.stringify({
      selectedSkillId: body.selectedSkillId ?? null,
      contextProfile: body.contextProfile ?? null,
      notebookContext: body.notebookContext ?? null,
      providerFallback: body.providerFallback === true,
    }, null, 2),
    '',
    'DASHBOARD_CONTEXT_JSON:',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function inferExportAction(
  userPrompt: string | undefined,
  allowedExportActions: Array<'mom-wow-analysis.xlsx' | 'sanluong-summary.xlsx'> | undefined
): AiExportAction | null {
  const prompt = String(userPrompt ?? '').toLowerCase();
  if (!/\b(export|download|excel|xlsx|workbook|report)\b/.test(prompt)) return null;
  const allowed = new Set(allowedExportActions ?? ['mom-wow-analysis.xlsx', 'sanluong-summary.xlsx']);
  if (/(sanluong|san luong|sản lượng|san lượng|full|summary)/i.test(prompt) && allowed.has('sanluong-summary.xlsx')) {
    return {
      type: 'dashboard-template-export',
      templateId: 'sanluong-summary',
      format: 'xlsx',
      fileName: 'sanluong-summary.xlsx',
    };
  }
  if (allowed.has('mom-wow-analysis.xlsx')) {
    return {
      type: 'dashboard-template-export',
      templateId: 'mom-wow-analysis',
      format: 'xlsx',
      fileName: 'mom-wow-analysis.xlsx',
    };
  }
  return null;
}

function parseStructuredAssistantPayload(text: string): AssistantStructuredPayload | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    ...Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1]?.trim() ?? ''),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed as AssistantStructuredPayload;
    } catch {
      // Continue trying other JSON candidates.
    }
  }
  return null;
}

function sanitizeDataRequest(value: unknown): AiDataRequest | null {
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
  if (dateFrom === false || dateTo === false || (dateFrom && dateTo && dateFrom > dateTo)) return null;
  const months = optionalKeyList(raw.months, isMonthKey);
  const weeks = optionalKeyList(raw.weeks, isWeekKey);
  const airlines = optionalTextList(raw.airlines, true);
  const routes = optionalTextList(raw.routes, true);
  const countries = optionalTextList(raw.countries, false);
  const aircraft = optionalTextList(raw.aircraft, true);
  if ([months, weeks, airlines, routes, countries, aircraft].some((entry) => entry === false)) return null;
  const typeFilter = optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const);
  const metric = optionalEnum(raw.metric, ['flights', 'pax'] as const);
  const dimension = optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const);
  const maxRecords = optionalPositiveInteger(raw.maxRecords, 500);
  if (typeFilter === false || metric === false || dimension === false || maxRecords === false) return null;
  return {
    type: 'dashboard-data-request',
    scope: raw.scope as AiDataRequest['scope'],
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(months ? { months } : {}),
    ...(weeks ? { weeks } : {}),
    ...(typeFilter ? { typeFilter } : {}),
    ...(airlines ? { airlines } : {}),
    ...(routes ? { routes } : {}),
    ...(countries ? { countries } : {}),
    ...(aircraft ? { aircraft } : {}),
    ...(metric ? { metric } : {}),
    ...(dimension ? { dimension } : {}),
    ...(maxRecords ? { maxRecords } : {}),
  };
}

function sanitizeDataQueries(value: unknown): AiDataQuery[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const queries: AiDataQuery[] = [];
  for (const entry of values.slice(0, 4)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const view = optionalEnum(raw.view, REPORTING_VIEWS);
    if (!view) continue;
    const filters = sanitizeDataQueryFilters(raw.filters);
    const groupBy = optionalTextList(raw.groupBy, false);
    const metrics = optionalTextList(raw.metrics, false);
    if (groupBy === false || metrics === false) continue;
    const validMetrics = (metrics ?? [])
      .map((metric) => metric.toLowerCase())
      .filter((metric): metric is AiQueryMetric => QUERY_METRICS.includes(metric as AiQueryMetric));
    const limit = optionalPositiveInteger(raw.limit, QUERY_LIMIT_CAP);
    if (limit === false) continue;
    const normalizedGroupBy = (groupBy ?? [])
      .slice(0, 4)
      .map(normalizeQueryColumn)
      .filter((column): column is string => Boolean(column) && QUERY_GROUP_BY_COLUMNS.includes(column));
    queries.push({
      queryId: sanitizeId(raw.queryId, `query-${queries.length + 1}`),
      view,
      filters,
      groupBy: normalizedGroupBy,
      metrics: validMetrics.length > 0 ? validMetrics : ['flights'],
      ...(typeof raw.orderBy === 'string' && QUERY_ORDER_COLUMNS.includes(normalizeQueryColumn(raw.orderBy)) ? { orderBy: normalizeQueryColumn(raw.orderBy) } : {}),
      limit: limit || 100,
    });
  }
  return queries;
}

function sanitizeSqlQueryPlans(value: unknown, body: AiRequestBody): AiSqlQueryPlan[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context as Record<string, unknown>
    : {};
  const sourcePolicy = context.dataSourcePolicy === 'supabase-reporting' ? 'supabase-reporting' : 'local-sqlite';
  const plans: AiSqlQueryPlan[] = [];
  for (const entry of values.slice(0, 4)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const sql = typeof raw.sql === 'string' ? raw.sql.trim() : '';
    if (!isSafeLocalSqlPlan(sql)) continue;
    const params = Array.isArray(raw.params)
      ? raw.params.slice(0, 24).map(sanitizeQueryCell)
      : [];
    const expectedColumns = Array.isArray(raw.expectedColumns)
      ? raw.expectedColumns.slice(0, 24).map((column) => sanitizeId(column, '')).filter(Boolean)
      : [];
    const visualizationHint = WORKSPACE_CHART_TYPES.includes(raw.visualizationHint as AiWorkspaceChartType)
      ? raw.visualizationHint as AiWorkspaceChartType
      : 'table';
    plans.push({
      queryId: sanitizeId(raw.queryId, `sql-${plans.length + 1}`),
      sql,
      params,
      reasonVi: sanitizeText(raw.reasonVi, 'Truy vấn SQLite local read-only do AI đề xuất.', 240),
      expectedColumns,
      visualizationHint,
      source: sourcePolicy === 'supabase-reporting' ? 'supabase-reporting' : 'local-sqlite',
    });
  }
  return plans;
}

function isSafeLocalSqlPlan(sql: string): boolean {
  if (!sql || sql.length > 6000 || sql.includes(';')) return false;
  const upper = sql.toUpperCase();
  if (!(upper.startsWith('SELECT ') || upper.startsWith('WITH '))) return false;
  if (!upper.includes('DASHBOARD_AI_FLIGHT_OPERATIONS')) return false;
  return !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|REPLACE|TRUNCATE|BEGIN|COMMIT|ROLLBACK|LOAD_EXTENSION)\b/.test(upper);
}

function sanitizeDataQueryFilters(value: unknown): AiDataQuery['filters'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const dateFrom = optionalIsoDate(raw.dateFrom);
  const dateTo = optionalIsoDate(raw.dateTo);
  const months = optionalKeyList(raw.months, isMonthKey);
  const weeks = optionalKeyList(raw.weeks, isWeekKey);
  const isoweeks = optionalKeyList(raw.isoweeks, isWeekKey);
  const weeknums = optionalIntegerList(raw.weeknums, 1, 53);
  const typeFilter = optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const);
  const seasonIds = optionalTextList(raw.seasonIds, false);
  const iataSeasonCodes = optionalTextList(raw.iataSeasonCodes, true);
  const airlines = optionalTextList(raw.airlines, true);
  const routes = optionalTextList(raw.routes, true);
  const countries = optionalTextList(raw.countries, false);
  const aircraft = optionalTextList(raw.aircraft, true);
  const acGroups = optionalTextList(raw.acGroups, false);
  const paxStatuses = optionalEnumList(raw.paxStatuses, DASHBOARD_AI_PAX_STATUSES);
  const localBuckets30 = optionalTextList(raw.localBuckets30, false);
  const localBuckets60 = optionalTextList(raw.localBuckets60, false);
  const utcBuckets30 = optionalTextList(raw.utcBuckets30, false);
  const utcBuckets60 = optionalTextList(raw.utcBuckets60, false);
  const localHourFrom = optionalHour(raw.localHourFrom);
  const localHourTo = optionalHour(raw.localHourTo);
  const invalid = [
    dateFrom,
    dateTo,
    months,
    weeks,
    isoweeks,
    weeknums,
    typeFilter,
    seasonIds,
    iataSeasonCodes,
    airlines,
    routes,
    countries,
    aircraft,
    acGroups,
    paxStatuses,
    localBuckets30,
    localBuckets60,
    utcBuckets30,
    utcBuckets60,
  ]
    .some((entry) => entry === false);
  if (invalid) return {};
  return {
    ...(seasonIds ? { seasonIds } : {}),
    ...(iataSeasonCodes ? { iataSeasonCodes } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(months ? { months } : {}),
    ...(weeks ? { weeks } : {}),
    ...(isoweeks ? { isoweeks } : {}),
    ...(weeknums ? { weeknums } : {}),
    ...(typeFilter ? { typeFilter } : {}),
    ...(airlines ? { airlines } : {}),
    ...(routes ? { routes } : {}),
    ...(countries ? { countries } : {}),
    ...(aircraft ? { aircraft } : {}),
    ...(acGroups ? { acGroups } : {}),
    ...(paxStatuses ? { paxStatuses } : {}),
    ...(localBuckets30 ? { localBuckets30 } : {}),
    ...(localBuckets60 ? { localBuckets60 } : {}),
    ...(utcBuckets30 ? { utcBuckets30 } : {}),
    ...(utcBuckets60 ? { utcBuckets60 } : {}),
    ...(localHourFrom != null ? { localHourFrom } : {}),
    ...(localHourTo != null ? { localHourTo } : {}),
  };
}

function shouldAutoQueryDashboardData(body: AiRequestBody): boolean {
  const allowedTools = new Set(body.allowedTools?.length ? body.allowedTools : DEFAULT_ALLOWED_TOOLS);
  if (!allowedTools.has('query_dashboard_data')) return false;
  if (body.allowDataRequest === false) return false;
  return isDashboardAiQueryIntentPrompt(body.userPrompt);
}

function inferDataQueryForPrompt(userPrompt: string | undefined, context: unknown): AiDataQuery | null {
  const rawPrompt = String(userPrompt ?? '');
  const prompt = normalizePrompt(rawPrompt);
  const year = inferContextYear(context);
  const dateRange = inferPromptDateRange(rawPrompt, String(year));
  const months = inferPromptMonths(prompt, year);
  const iataSeasonCodes = Array.from(new Set(Array.from(rawPrompt.matchAll(/\b[SW]\d{2}\b/gi)).map((match) => match[0].toUpperCase())));
  const wantsSelectedSeasonSet = /\b(mua lien tiep|mua da chon|selected seasons|consecutive seasons|so sanh cac mua|so sanh mua)\b/.test(prompt);
  const selectedSeasonIds = wantsSelectedSeasonSet
    ? selectedSeasonSetFromContext(context, { expandAdjacent: true })
    : selectedSeasonSetFromContext(context);
  const airlines = /\b(vn|vietnam airlines)\b/i.test(rawPrompt) ? ['VN'] : [];
  const hasPax = /\b(pax|khach|khách)\b/.test(prompt);
  const wantsRoute = /\b(route|duong bay|đường bay)\b/.test(prompt);
  const wantsCountry = /\b(country|quoc gia)\b/.test(prompt);
  const wantsAircraft = /\b(aircraft|may bay|máy bay|tau bay|tàu bay)\b/.test(prompt);
  const wantsTypeMix = /\b(arr\/dep|arr dep|arrival|departure|arrivals|departures|mix|co cau arr|co cau dep)\b/.test(prompt);
  const wantsGate = /\b(gate|cong)\b/.test(prompt);
  const wantsWeek = /\b(weekly|hang tuan|hàng tuần|tuan|tuần|week)\b/.test(prompt);
  const wantsPeak = /\b(peak hour|cao diem|cao điểm|7-8|7am|8am)\b/.test(prompt);
  const wantsDailyPeak = /\b(ngay|daily|theo ngay|phan bo theo ngay|cao diem|bat thuong|anomaly)\b/.test(prompt) &&
    /\b(cao diem|nhieu nhat|cao nhat|peak|bat thuong|anomaly)\b/.test(prompt);
  const wantsSeasonComparison = iataSeasonCodes.length > 1 || wantsSelectedSeasonSet;
  const hours = inferPromptHours(prompt);
  const groupBy = wantsGate ? ['gate'] : wantsWeek ? ['iso_week'] : wantsRoute ? ['route'] : wantsCountry ? ['country'] : wantsAircraft ? ['aircraft'] : wantsTypeMix ? ['type'] : wantsSeasonComparison ? ['season'] : dateRange || (months.length > 0 && wantsDailyPeak) ? ['ops_date'] : ['airline'];
  return {
    queryId: 'auto-query-1',
    view: 'flight_operations',
    filters: {
      ...(wantsSelectedSeasonSet && selectedSeasonIds.length ? { seasonIds: selectedSeasonIds } : {}),
      ...(!wantsSelectedSeasonSet && iataSeasonCodes.length ? { iataSeasonCodes } : {}),
      ...(dateRange?.dateFrom ? { dateFrom: dateRange.dateFrom } : {}),
      ...(dateRange?.dateTo ? { dateTo: dateRange.dateTo } : {}),
      ...(!dateRange && months.length ? { months } : {}),
      ...(airlines.length ? { airlines } : {}),
      ...(wantsPeak && hours ? { localHourFrom: hours.from, localHourTo: hours.to } : {}),
    },
    groupBy,
    metrics: hasPax ? ['pax', 'flights'] : ['flights', 'pax'],
    orderBy: hasPax ? 'pax' : 'flights',
    limit: /\btop\s+10\b/.test(prompt) ? 10 : 24,
  };
}

function mergeQueryResults(left: AiQueryResult[], right: AiQueryResult[]): AiQueryResult[] {
  const merged = new Map<string, AiQueryResult>();
  for (const result of [...left, ...right]) merged.set(result.queryId, result);
  return Array.from(merged.values()).slice(0, 4);
}

function shouldPreferQueryResults(userPrompt: string | undefined, queryResults: AiQueryResult[], boardPatch: AiBoardPatch | null): boolean {
  if (!queryResults.some((result) => result.rows.length > 0)) return false;
  if (!shouldAutoQueryDashboardData({ userPrompt, allowedTools: ['query_dashboard_data'] })) return false;
  const queryIds = new Set(queryResults.map((result) => result.queryId).filter(Boolean));
  if (!boardPatch) return true;
  return !boardPatch.blocks.some((block) => {
    const sourceQueryId = block.table?.sourceQueryId ?? block.chart?.sourceQueryId;
    return sourceQueryId ? queryIds.has(sourceQueryId) : false;
  });
}

async function resolveDashboardDataQueries(
  supabase: DashboardSupabaseClient,
  queries: AiDataQuery[]
): Promise<AiQueryResult[]> {
  const results: AiQueryResult[] = [];
  for (const query of queries.slice(0, 4)) {
    const result = await resolveDashboardDataQuery(supabase, query);
    if (result) results.push(result);
  }
  return results;
}

async function resolveDashboardDataQuery(
  supabase: DashboardSupabaseClient,
  query: AiDataQuery
): Promise<AiQueryResult | null> {
  if (query.groupBy.length > 0) {
    return resolveAggregatedDashboardDataQuery(supabase, query);
  }
  return resolveDashboardRowsDataQuery(supabase, query);
}

async function resolveDashboardRowsDataQuery(
  supabase: DashboardSupabaseClient,
  query: AiDataQuery
): Promise<AiQueryResult> {
  const sourceView: AiReportingView = query.view;
  const limit = Math.min(Math.max(1, query.limit || 100), QUERY_LIMIT_CAP);
  const { data, error } = await (supabase.rpc('dashboard_ai_query_rows', {
    p_view: sourceView,
    p_filters: query.filters,
    p_columns: [],
    p_order_by: query.orderBy ?? 'ops_date',
    p_order_dir: query.orderBy ? 'desc' : 'asc',
    p_limit: limit,
  }) as PromiseLike<DashboardRpcResponse>);
  if (error) {
    const filterSummary = JSON.stringify(query.filters);
    return {
      queryId: query.queryId,
      view: sourceView,
      columns: ['Ghi chú'],
      rows: [{ 'Ghi chú': `Không truy vấn được dashboard_ai_query_rows cho reporting.${sourceView}: ${error.message}. Filters: ${filterSummary}` }],
      rowCount: 0,
      truncated: false,
      dataQualityNotes: [`Không truy vấn được dashboard_ai_query_rows cho reporting.${sourceView}: ${error.message}. Filters: ${filterSummary}`],
    };
  }
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const fallbackColumns = query.groupBy.concat(query.metrics);
  const rows = sanitizeQueryRows(payload.rows, fallbackColumns);
  const columns = Array.isArray(payload.columns)
    ? payload.columns.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : rows.length > 0 ? Object.keys(rows[0]) : fallbackColumns;
  const rowCount = typeof payload.rowCount === 'number' && Number.isFinite(payload.rowCount) ? Math.max(0, Math.floor(payload.rowCount)) : rows.length;
  return {
    queryId: query.queryId,
    view: sourceView,
    columns,
    rows,
    rowCount,
    truncated: payload.truncated === true,
    dataQualityNotes: buildQueryDataQualityNotes(query),
  };
}

async function resolveAggregatedDashboardDataQuery(
  supabase: DashboardSupabaseClient,
  query: AiDataQuery
): Promise<AiQueryResult> {
  const groupBy = query.groupBy.filter((column) => QUERY_GROUP_BY_COLUMNS.includes(column)).slice(0, 4);
  const metrics = query.metrics.filter((metric): metric is AiQueryMetric => QUERY_METRICS.includes(metric)).slice(0, 4);
  const orderBy = query.orderBy && QUERY_ORDER_COLUMNS.includes(query.orderBy) ? query.orderBy : metrics[0] ?? 'flights';
  const limit = Math.min(Math.max(1, query.limit || 24), QUERY_LIMIT_CAP);
  const { data, error } = await (supabase.rpc('dashboard_ai_query_aggregated', {
    p_filters: query.filters,
    p_group_by: groupBy,
    p_metrics: metrics.length > 0 ? metrics : ['flights'],
    p_order_by: orderBy,
    p_order_dir: 'desc',
    p_limit: limit,
  }) as PromiseLike<DashboardRpcResponse>);
  if (error) {
    return {
      queryId: query.queryId,
      view: 'flight_operations',
      columns: ['Ghi chú'],
      rows: [{ 'Ghi chú': `Không truy vấn được dashboard_ai_query_aggregated: ${error.message}` }],
      rowCount: 0,
      truncated: false,
      dataQualityNotes: [`Không truy vấn được dashboard_ai_query_aggregated: ${error.message}`],
    };
  }
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const rows = sanitizeQueryRows(payload.rows, groupBy.concat(metrics));
  const columns = Array.isArray(payload.columns)
    ? payload.columns.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : rows.length > 0 ? Object.keys(rows[0]) : groupBy.concat(metrics);
  const rowCount = typeof payload.rowCount === 'number' && Number.isFinite(payload.rowCount) ? Math.max(0, Math.floor(payload.rowCount)) : rows.length;
  return {
    queryId: query.queryId,
    view: 'flight_operations',
    columns,
    rows,
    rowCount,
    truncated: payload.truncated === true,
    dataQualityNotes: buildQueryDataQualityNotes(query),
  };
}

function buildQueryDataQualityNotes(query: AiDataQuery): string[] {
  const notes = [`Nguồn dữ liệu: reporting.${query.groupBy.length > 0 ? 'flight_operations' : query.view}; queryId=${query.queryId}.`];
  if (/\binternational|domestic|quoc te|quốc tế|noi dia|nội địa\b/.test(JSON.stringify(query).toLowerCase())) {
    notes.push('Reporting view hiện chưa có field quốc tế/nội địa chuẩn hóa, nên không áp filter này.');
  }
  return notes;
}

async function executeGeminiToolCall(
  supabase: DashboardSupabaseClient,
  toolCall: { name: AiToolName; args: Record<string, unknown> },
  body: AiRequestBody,
  round: number
): Promise<{ response: Record<string, unknown>; queryResults: AiQueryResult[]; terminalText?: string }> {
  if (toolCall.name === 'query_dashboard_data') {
    const queryArgs = {
      queryId: `tool-query-${round}`,
      view: 'flight_operations',
      filters: {},
      groupBy: [],
      metrics: ['flights'],
      limit: 24,
      ...toolCall.args,
    };
    const queries = sanitizeDataQueries(queryArgs);
    const queryResults = await resolveDashboardDataQueries(supabase, queries);
    return {
      queryResults,
      response: {
        accepted: queryResults.length > 0,
        queryResults,
        message: queryResults.length > 0 ? 'Đã truy vấn dữ liệu dashboard.' : 'Không tạo được truy vấn hợp lệ từ tool call.',
      },
    };
  }

  if (toolCall.name === 'compose_dashboard_ai_board') {
    const boardPatch = sanitizeBoardPatch(toolCall.args, body);
    if (boardPatch) {
      const terminalText = JSON.stringify({
        assistantText: 'Đã tạo notebook block trực quan theo yêu cầu.',
        boardPatch,
        toolTraceSummary: [{
          tool: 'compose_dashboard_ai_board',
          status: 'executed',
          reason: 'Gemini đã gọi tool compose_dashboard_ai_board bằng native function calling.',
          toolset: 'dashboard-visual',
          providerAttempt: round,
        }],
      });
      return {
        queryResults: [],
        terminalText,
        response: {
          accepted: true,
          boardPatch,
        },
      };
    }
    return {
      queryResults: [],
      response: {
        accepted: false,
        message: 'BoardPatch bị từ chối vì không khớp whitelist block/chart/table.',
      },
    };
  }

  return {
    queryResults: [],
    response: {
      accepted: false,
      message: `Tool ${toolCall.name} chưa được hỗ trợ trong native function calling.`,
    },
  };
}

function sanitizeQueryCell(value: unknown): AiQueryCell {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^[=+\-@]/.test(value) ? `'${value.slice(0, 500)}` : value.slice(0, 500);
  return String(value).slice(0, 500);
}

function normalizeQueryColumn(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return NORMALIZED_QUERY_COLUMNS.has(normalized) ? normalized : '';
}

function sanitizeExportAction(value: unknown, body: AiRequestBody): AiExportAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== 'xlsx') return null;
  const allowed = new Set(body.allowedExportActions ?? ['mom-wow-analysis.xlsx', 'sanluong-summary.xlsx']);
  const allowedTemplates = new Set(body.allowedReportTemplates?.length ? body.allowedReportTemplates : DEFAULT_ALLOWED_REPORT_TEMPLATES);
  if ((raw.type === 'dashboard-template-export' || raw.type === 'dashboard-analysis-export') && raw.templateId === 'mom-wow-analysis' && raw.fileName === 'mom-wow-analysis.xlsx' && allowed.has('mom-wow-analysis.xlsx') && allowedTemplates.has('mom-wow-analysis')) {
    return { type: 'dashboard-template-export', templateId: 'mom-wow-analysis', format: 'xlsx', fileName: 'mom-wow-analysis.xlsx' };
  }
  if ((raw.type === 'dashboard-template-export' || raw.type === 'dashboard-analysis-export') && raw.templateId === 'sanluong-summary' && raw.fileName === 'sanluong-summary.xlsx' && allowed.has('sanluong-summary.xlsx') && allowedTemplates.has('sanluong-summary')) {
    return { type: 'dashboard-template-export', templateId: 'sanluong-summary', format: 'xlsx', fileName: 'sanluong-summary.xlsx' };
  }
  if (body.allowCustomWorkbook !== false && raw.type === 'dashboard-custom-workbook' && raw.workbookSpec) {
    return {
      type: 'dashboard-custom-workbook',
      format: 'xlsx',
      fileName: typeof raw.fileName === 'string' ? raw.fileName : undefined,
      workbookSpec: raw.workbookSpec,
    };
  }
  return null;
}

function sanitizeVisualReport(value: unknown, body: AiRequestBody): AiVisualReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowedTemplates = body.allowedVisualReports?.length ? body.allowedVisualReports : DEFAULT_ALLOWED_VISUAL_REPORTS;
  const templateId = optionalEnum(raw.templateId, allowedTemplates);
  if (!templateId || !Array.isArray(raw.blocks)) return null;
  const filters = sanitizeVisualFilters(raw.filters);
  const blocks: AiVisualReportBlock[] = [];
  for (const blockValue of raw.blocks.slice(0, 8)) {
    const block = sanitizeVisualBlock(blockValue, blocks.length);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return {
    templateId,
    title: sanitizeText(raw.title, visualTemplateTitle(templateId), 80),
    filters,
    blocks,
    insights: sanitizeTextList(raw.insights, 8),
    dataQualityNotes: sanitizeTextList(raw.dataQualityNotes, 8),
  };
}

function sanitizeBoardPatch(value: unknown, body: AiRequestBody): AiBoardPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedTools = new Set(body.allowedTools?.length ? body.allowedTools : DEFAULT_ALLOWED_TOOLS);
  if (!allowedTools.has('compose_dashboard_ai_board')) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.blocks)) return null;
  const blocks: AiWorkspaceBlock[] = [];
  for (const blockValue of raw.blocks.slice(0, 12)) {
    const block = sanitizeWorkspaceBlock(blockValue, blocks.length);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return {
    title: sanitizeText(raw.title, 'AI Workspace Board', 80),
    blocks,
    append: raw.append === true,
  };
}

function inferBoardPatch(userPrompt: string | undefined, visualReport: AiVisualReport | null, body: AiRequestBody): AiBoardPatch | null {
  const allowedTools = new Set(body.allowedTools?.length ? body.allowedTools : DEFAULT_ALLOWED_TOOLS);
  if (!allowedTools.has('compose_dashboard_ai_board')) return null;
  const boardIntent = body.preferredTool === 'compose_dashboard_ai_board' || isWorkspaceBoardIntent(userPrompt);
  if (visualReport && boardIntent) {
    const visualPatch = boardPatchFromVisualReport(visualReport, body);
    if (visualPatch) return visualPatch;
  }
  if (!boardIntent) return null;
  return defaultBoardPatchForPrompt(userPrompt, body);
}

function boardPatchFromQueryResults(queryResults: AiQueryResult[], userPrompt: string | undefined, body: AiRequestBody): AiBoardPatch | null {
  const result = queryResults[0];
  if (!result || result.rows.length === 0 || result.columns.length === 0) return null;
  const prompt = normalizePrompt(userPrompt);
  const numericColumns = result.columns.filter((column) => result.rows.some((row) => typeof row[column] === 'number'));
  const labelColumn = result.columns.find((column) => !numericColumns.includes(column)) ?? result.columns[0] ?? 'label';
  const primaryMetric = numericColumns.find((column) => /pax/i.test(column)) ?? numericColumns[0] ?? 'value';
  const chartType: AiWorkspaceChartType = /\b(heatmap|ban do nhiet)\b/.test(prompt)
    ? 'heatmap'
    : /\b(waterfall|driver|delta|bien dong)\b/.test(prompt)
      ? 'waterfall'
      : /\b(trend|weekly|hang tuan|month|thang)\b/.test(prompt)
        ? 'line-trend'
        : 'bar-ranking';
  return sanitizeBoardPatch({
    title: 'Kết quả truy vấn dữ liệu AI',
    blocks: [
      {
        id: `${result.queryId}-table`,
        type: 'table',
        title: 'Bảng dữ liệu AI đã truy vấn',
        source: 'resolvedDataRequest',
        table: {
          templateId: 'custom-table',
          title: 'Bảng dữ liệu AI đã truy vấn',
          columns: result.columns,
          rows: result.rows,
          source: 'resolvedDataRequest',
          sourceQueryId: result.queryId,
          filters: {},
          limit: result.rows.length,
        },
      },
      ...(numericColumns.length > 0 ? [{
        id: `${result.queryId}-chart`,
        type: 'chart',
        title: 'Biểu đồ dữ liệu AI đã truy vấn',
        source: 'resolvedDataRequest',
        chart: {
          chartType,
          title: 'Biểu đồ dữ liệu AI đã truy vấn',
          source: 'resolvedDataRequest',
          sourceQueryId: result.queryId,
          x: labelColumn,
          series: [primaryMetric],
          rows: result.rows,
          filters: {},
          limit: result.rows.length,
        },
      }] : []),
      workspaceInsightBlock(`${result.queryId}-notes`, 'Ghi chú dữ liệu', 'resolvedDataRequest', result.dataQualityNotes.length > 0
        ? result.dataQualityNotes
        : [`Đã truy vấn ${result.rowCount.toLocaleString('en-US')} dòng từ reporting.${result.view}.`], 'data-quality-notes'),
    ],
    append: false,
  }, body);
}

function boardPatchFromVisualReport(report: AiVisualReport, body: AiRequestBody): AiBoardPatch | null {
  const blocks: Array<Record<string, unknown>> = [];
  for (const visualBlock of report.blocks) {
    const block = convertVisualBlockToWorkspaceBlock(visualBlock, report.filters);
    if (block) blocks.push(block);
  }
  if (report.insights.length > 0) {
    blocks.push(workspaceInsightBlock('visual-insights', 'Key Insights', 'resolvedDataRequest', report.insights));
  }
  if (report.dataQualityNotes.length > 0) {
    blocks.push(workspaceInsightBlock('visual-data-quality', 'Ghi chú chất lượng dữ liệu', 'resolvedDataRequest', report.dataQualityNotes, 'data-quality-notes'));
  }
  return sanitizeBoardPatch({ title: report.title, blocks, append: false }, body);
}

function convertVisualBlockToWorkspaceBlock(block: AiVisualReportBlock, filters: AiVisualReport['filters']): Record<string, unknown> | null {
  const baseFilters = {
    comparisonMode: filters.comparisonMode,
    metric: block.metric ?? filters.metric,
    typeFilter: filters.typeFilter,
    timeBasis: filters.timeBasis,
  };
  if (block.type === 'kpi-summary') return workspaceKpiBlock(`visual-${block.id}`, block.title, block.source);
  if (block.type === 'monthly-trend') return workspaceChartBlock(`visual-${block.id}`, block.title, 'resolvedDataRequest', 'line-trend', { ...baseFilters, dimension: 'month' }, block.limit ?? 12);
  if (block.type === 'driver-waterfall') return workspaceChartBlock(`visual-${block.id}`, block.title, 'resolvedDataRequest', 'waterfall', { ...baseFilters, dimension: block.dimension ?? filters.dimension }, block.limit ?? 12);
  if (block.type === 'peak-hour') return workspaceChartBlock(`visual-${block.id}`, block.title, 'resolvedDataRequest', 'bar-ranking', { ...baseFilters, dimension: 'hourBucket' }, block.limit ?? 12);
  if (block.type === 'route-country-ranking') return workspaceChartBlock(`visual-${block.id}`, block.title, 'resolvedDataRequest', 'bar-ranking', { ...baseFilters, dimension: 'route' }, block.limit ?? 12);
  if (block.type === 'airline-mix-ranking') return workspaceChartBlock(`visual-${block.id}`, block.title, 'resolvedDataRequest', 'bar-ranking', { ...baseFilters, dimension: 'airline' }, block.limit ?? 12);
  return workspaceInsightBlock(`visual-${block.id}`, block.title, block.source, ['Review this visual block from the AI report.']);
}

function defaultBoardPatchForPrompt(userPrompt: string | undefined, body: AiRequestBody): AiBoardPatch | null {
  const prompt = normalizePrompt(userPrompt);
  if (isDifferenceComparisonPrompt(prompt)) {
    return sanitizeBoardPatch({
      title: comparisonDifferenceBoardTitle(userPrompt),
      blocks: [
        workspaceTableBlock('difference-driver-table', 'Bảng driver từ truy vấn độc lập', 'resolvedDataRequest', 'custom-table', 12, comparisonDifferenceFilters(userPrompt)),
        workspaceChartBlock('difference-waterfall', 'Waterfall biến động từ query result', 'resolvedDataRequest', 'waterfall', { ...comparisonDifferenceFilters(userPrompt), dimension: 'airline', metric: 'flights' }, 12),
        workspaceInsightBlock('difference-notes', 'Nhận định khác biệt', 'resolvedDataRequest', ['AI Workspace ưu tiên Supabase reporting queryResults độc lập theo prompt; không dùng bảng MoM/WoW hiện tại.']),
      ],
      append: false,
    }, body);
  }
  if (isCompareSeasonsPrompt(prompt)) {
    return sanitizeBoardPatch({
      title: 'Bảng so sánh các mùa đã chọn',
      blocks: [
        workspaceTableBlock('multi-season-summary', 'Tổng hợp các mùa đã chọn', 'multiSeason', 'multi-season-summary', 3),
        workspaceChartBlock('multi-season-chart', 'Flights by Selected Season', 'multiSeason', 'bar-ranking', { dimension: 'season', metric: 'flights' }, 3),
        workspaceInsightBlock('multi-season-notes', 'Ghi chú so sánh', 'multiSeason', ['Block multi-season giới hạn theo tối đa 3 mùa đã chọn.']),
      ],
      append: false,
    }, body);
  }
  if (isPeakHourPrompt(prompt)) {
    return sanitizeBoardPatch({
      title: 'Bảng phân tích khung giờ cao điểm',
      blocks: [
        workspaceChartBlock('peak-hour-chart', 'Peak Hour Distribution', 'resolvedDataRequest', 'bar-ranking', { dimension: 'hourBucket', metric: 'flights' }, 24),
        workspaceTableBlock('peak-hour-table', 'Peak Hour Table', 'resolvedDataRequest', 'custom-table', 24),
        workspaceInsightBlock('peak-hour-notes', 'Ghi chú peak hour', 'resolvedDataRequest', ['Block peak hour cần dataQueries/queryResults từ Supabase reporting theo khung giờ.']),
      ],
      append: false,
    }, body);
  }
  if (isDriverPrompt(prompt)) {
    return sanitizeBoardPatch({
      title: 'Bảng phân tích tác nhân',
      blocks: [
        workspaceTableBlock('driver-table', 'Driver Contribution Table', 'resolvedDataRequest', 'custom-table', 12),
        workspaceChartBlock('driver-waterfall', 'Driver Waterfall', 'resolvedDataRequest', 'waterfall', { dimension: 'airline', metric: 'flights' }, 12),
        workspaceInsightBlock('driver-notes', 'Ghi chú tác nhân', 'resolvedDataRequest', ['Block driver chỉ render từ queryResults/sourceQueryId hợp lệ của AI Workspace.']),
      ],
      append: false,
    }, body);
  }
  if (isTablePrompt(prompt)) {
    return sanitizeBoardPatch({
      title: 'Bảng báo cáo dạng bảng',
      blocks: [
        workspaceTableBlock('season-summary-table', 'Season Summary Table', 'multiSeason', 'season-summary', 3),
        workspaceTableBlock('airline-ranking-table', 'Bảng xếp hạng hãng bay', 'resolvedDataRequest', 'custom-table', 12),
        workspaceTableBlock('route-country-table', 'Route Country Table', 'resolvedDataRequest', 'custom-table', 12),
      ],
      append: false,
    }, body);
  }
  if (isVisualPrompt(prompt)) {
    return sanitizeBoardPatch({
      title: 'Bảng báo cáo trực quan AI',
      blocks: [
        workspaceKpiBlock('visual-kpis', 'KPI tổng quan', 'seasonCatalog'),
        workspaceChartBlock('visual-monthly-trend', 'Xu hướng chuyến bay theo tháng', 'resolvedDataRequest', 'line-trend', { dimension: 'month', metric: 'flights' }, 12),
        workspaceChartBlock('visual-peak-hour', 'Peak Hour Distribution', 'resolvedDataRequest', 'bar-ranking', { dimension: 'hourBucket', metric: 'flights' }, 12),
        workspaceTableBlock('visual-airline-ranking', 'Bảng xếp hạng hãng bay', 'resolvedDataRequest', 'custom-table', 12),
        workspaceInsightBlock('visual-board-notes', 'Nhận định phân tích', 'resolvedDataRequest', ['Các block cần dữ liệu từ Supabase reporting queryResults/sourceQueryId.']),
      ],
      append: false,
    }, body);
  }
  return sanitizeBoardPatch({
    title: 'AI Workspace Board',
    blocks: [
      workspaceKpiBlock('workspace-kpis', 'KPI tổng quan', 'seasonCatalog'),
      workspaceTableBlock('workspace-season-summary', 'Selected Season Summary', 'multiSeason', 'season-summary', 3),
      workspaceChartBlock('workspace-monthly-trend', 'Xu hướng chuyến bay theo tháng', 'resolvedDataRequest', 'line-trend', { dimension: 'month', metric: 'flights' }, 12),
      workspaceChartBlock('workspace-airline-ranking', 'Top Airlines', 'resolvedDataRequest', 'bar-ranking', { dimension: 'airline', metric: 'flights' }, 12),
    ],
    append: false,
  }, body);
}

function workspaceKpiBlock(id: string, title: string, source: AiWorkspaceBlockSource): Record<string, unknown> {
  return { id, type: 'kpi', title, source };
}

function workspaceChartBlock(
  id: string,
  title: string,
  source: AiWorkspaceBlockSource,
  chartType: AiWorkspaceChartType,
  filters: Record<string, string>,
  limit: number
): Record<string, unknown> {
  return {
    id,
    type: 'chart',
    title,
    source,
    chart: { chartType, title, source, filters, series: ['flights'], limit },
  };
}

function workspaceTableBlock(
  id: string,
  title: string,
  source: AiWorkspaceBlockSource,
  templateId: AiWorkspaceTableTemplateId,
  limit: number,
  filters: Record<string, string> = {}
): Record<string, unknown> {
  return {
    id,
    type: 'table',
    title,
    source,
    table: { templateId, title, columns: ['label', 'flights'], source, filters, limit },
  };
}

function workspaceInsightBlock(
  id: string,
  title: string,
  source: AiWorkspaceBlockSource,
  insights: string[],
  type: 'insight-list' | 'data-quality-notes' = 'insight-list'
): Record<string, unknown> {
  return { id, type, title, source, insights };
}

function sanitizeToolTraceSummary(
  value: unknown,
  body: AiRequestBody,
  inferred: { queryResults: AiQueryResult[]; dataRequest: AiDataRequest | null; exportAction: AiExportAction | null; visualReport: AiVisualReport | null; boardPatch: AiBoardPatch | null }
): AiToolTraceEntry[] {
  const allowedTools = new Set(body.allowedTools?.length ? body.allowedTools : DEFAULT_ALLOWED_TOOLS);
  const traces: AiToolTraceEntry[] = [];
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (typeof raw.tool !== 'string' || !allowedTools.has(raw.tool as AiToolName)) continue;
      const status = optionalEnum(raw.status, TOOL_TRACE_STATUSES) || 'accepted';
      traces.push({
        tool: raw.tool as AiToolName,
        status,
        reason: sanitizeText(raw.reason, '', 160),
        ...(optionalEnum(raw.phase, ['generated_sql', 'validated_sql', 'executed_local_sql', 'profiled_query_result', 'verified_answer', 'rendered_rich_chat', 'rendered_sandbox_html', 'rejected_unsafe_render']) ? { phase: raw.phase as AiToolTracePhase } : {}),
        ...(typeof raw.skill === 'string' ? { skill: sanitizeText(raw.skill, '', 80) } : {}),
        ...(optionalEnum(raw.toolset, ['dashboard-readonly', 'dashboard-visual', 'dashboard-export', 'dashboard-memory']) ? { toolset: raw.toolset as AiToolset } : {}),
        ...(typeof raw.fallbackReason === 'string' ? { fallbackReason: sanitizeText(raw.fallbackReason, '', 160) } : {}),
        ...(optionalEnum(raw.contextProfile, ['overview', 'peak-hour', 'route-country', 'airline-mix', 'season-overview', 'multi-season', 'validated-sql', 'eda-profile', 'data-quality', 'visualization', 'answer-verification', 'safe-rendering']) ? { contextProfile: raw.contextProfile as AiContextProfile } : {}),
        ...(typeof raw.providerAttempt === 'number' && Number.isFinite(raw.providerAttempt) && raw.providerAttempt > 0 ? { providerAttempt: Math.min(4, Math.floor(raw.providerAttempt)) } : {}),
      });
    }
  }
  if (traces.length > 0) return traces;
  const inferredTool = inferToolFromActions(body.userPrompt, inferred);
  if (inferred.queryResults.length > 0 && allowedTools.has('query_dashboard_data')) {
    return [{
      tool: 'query_dashboard_data',
      status: 'executed',
      reason: `Đã truy vấn ${inferred.queryResults[0].rowCount.toLocaleString('en-US')} dòng từ reporting.${inferred.queryResults[0].view}.`,
      toolset: 'dashboard-readonly',
      ...(body.selectedSkillId ? { skill: body.selectedSkillId } : {}),
      ...(body.contextProfile ? { contextProfile: body.contextProfile } : {}),
    }];
  }
  return allowedTools.has(inferredTool)
    ? [{
        tool: inferredTool,
        status: 'accepted',
        reason: 'Đã chọn tool theo hợp đồng Dashboard AI.',
        ...(body.selectedSkillId ? { skill: body.selectedSkillId } : {}),
        ...(body.contextProfile ? { contextProfile: body.contextProfile } : {}),
      }]
    : [];
}

function sanitizeVisualFilters(value: unknown): AiVisualReport['filters'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    comparisonMode: optionalEnum(raw.comparisonMode, ['mom', 'wow'] as const) || 'mom',
    metric: optionalEnum(raw.metric, ['flights', 'pax'] as const) || 'flights',
    typeFilter: optionalEnum(raw.typeFilter, ['all', 'A', 'D'] as const) || 'all',
    dimension: optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const) || 'airline',
    timeBasis: optionalEnum(raw.timeBasis, ['local', 'utc'] as const) || 'local',
  };
}

function sanitizeVisualBlock(value: unknown, index: number): AiVisualReportBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = optionalEnum(raw.type, VISUAL_BLOCK_TYPES);
  const source = optionalEnum(raw.source, VISUAL_BLOCK_SOURCES);
  if (!type || !source) return null;
  const block: AiVisualReportBlock = {
    id: sanitizeId(raw.id, `block-${index + 1}`),
    type,
    title: sanitizeText(raw.title, type, 80),
    source,
  };
  const metric = optionalEnum(raw.metric, ['flights', 'pax'] as const);
  const dimension = optionalEnum(raw.dimension, ['airline', 'route', 'country', 'aircraft', 'type', 'dayOfWeek', 'hourBucket', 'flightNumber'] as const);
  const limit = optionalPositiveInteger(raw.limit, 24);
  if (metric) block.metric = metric;
  if (dimension) block.dimension = dimension;
  if (limit) block.limit = limit;
  return block;
}

function sanitizeWorkspaceBlock(value: unknown, index: number): AiWorkspaceBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = optionalEnum(raw.type, WORKSPACE_BLOCK_TYPES);
  const source = optionalEnum(raw.source, WORKSPACE_BLOCK_SOURCES);
  if (!type || !source) return null;
  const block: AiWorkspaceBlock = {
    id: sanitizeId(raw.id, `block-${index + 1}`),
    type,
    title: sanitizeText(raw.title, type, 80),
    source,
  };
  if (type === 'chart') {
    const chart = sanitizeWorkspaceChart(raw.chart, source, block.title);
    if (!chart) return null;
    block.chart = chart;
  } else if (type === 'table') {
    const table = sanitizeWorkspaceTable(raw.table, source, block.title);
    if (!table) return null;
    block.table = table;
  } else if (type === 'insight-list' || type === 'data-quality-notes') {
    const insights = sanitizeTextList(raw.insights ?? raw.notes, 8);
    if (insights.length === 0) return null;
    block.insights = insights;
  } else if (type === 'rich-markdown') {
    const content = sanitizeRichMarkdown(raw.markdown ?? raw.content);
    if (!content) return null;
    block.markdown = { content };
  } else if (type === 'html-preview') {
    const htmlPreview = sanitizeHtmlPreview(raw.htmlPreview ?? raw.html ?? raw.content);
    if (!htmlPreview) return null;
    block.htmlPreview = htmlPreview;
  }
  return block;
}

function sanitizeWorkspaceChart(value: unknown, fallbackSource: AiWorkspaceBlockSource, fallbackTitle: string): AiWorkspaceChartSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const chartType = optionalEnum(raw.chartType, WORKSPACE_CHART_TYPES);
  if (!chartType) return null;
  const source = optionalEnum(raw.source, WORKSPACE_BLOCK_SOURCES) || fallbackSource;
  const series = Array.isArray(raw.series)
    ? raw.series.slice(0, 4).map((entry) => sanitizeId(entry, '')).filter(Boolean)
    : [];
  const sourceQueryId = sanitizeId(raw.sourceQueryId, '');
  const x = sanitizeId(raw.x, '');
  const stackBy = sanitizeId(raw.stackBy, '');
  const colorBy = sanitizeId(raw.colorBy, '');
  const rows = sanitizeQueryRows(raw.rows, []);
  const limit = optionalPositiveInteger(raw.limit, 24);
  return {
    chartType,
    title: sanitizeText(raw.title, fallbackTitle, 80),
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

function sanitizeWorkspaceTable(value: unknown, fallbackSource: AiWorkspaceBlockSource, fallbackTitle: string): AiWorkspaceTableSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const templateId = optionalEnum(raw.templateId, WORKSPACE_TABLE_TEMPLATES);
  const source = optionalEnum(raw.source, WORKSPACE_BLOCK_SOURCES) || fallbackSource;
  const tableData = sanitizeQueryTableData(raw.rows, raw.columns);
  if (!templateId && tableData.rows.length === 0) return null;
  const sourceQueryId = sanitizeId(raw.sourceQueryId, '');
  const limit = optionalPositiveInteger(raw.limit, 24);
  return {
    templateId: templateId || 'custom-table',
    title: sanitizeText(raw.title, fallbackTitle, 80),
    columns: tableData.columns,
    source,
    filters: sanitizeWorkspaceFilters(raw.filters),
    ...(sourceQueryId ? { sourceQueryId } : {}),
    ...(tableData.rows.length ? { rows: tableData.rows } : {}),
    ...(limit ? { limit } : {}),
  };
}

function sanitizeRichMarkdown(value: unknown): string {
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

function sanitizeHtmlPreview(value: unknown): AiHtmlPreviewSpec | null {
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
      html: '<div>HTML preview đã bị từ chối vì không còn nội dung an toàn sau khi sanitize.</div>',
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

function sanitizeWorkspaceFilters(value: unknown): Record<string, string> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, string> = {};
  for (const key of ['comparisonMode', 'metric', 'typeFilter', 'dimension', 'timeBasis']) {
    if (typeof raw[key] === 'string') result[key] = sanitizeId(raw[key], '');
  }
  for (const key of ['currentPeriod', 'previousPeriod']) {
    if (typeof raw[key] === 'string' && /^(\d{4}-\d{2}|\d{4}-W\d{2})$/.test(raw[key])) result[key] = raw[key];
  }
  for (const key of ['currentMonth', 'previousMonth']) {
    const month = typeof raw[key] === 'string' || typeof raw[key] === 'number' ? Number(raw[key]) : NaN;
    if (Number.isInteger(month) && month >= 1 && month <= 12) result[key] = String(month).padStart(2, '0');
  }
  return result;
}

function inferToolFromActions(
  userPrompt: string | undefined,
  actions: { queryResults: AiQueryResult[]; dataRequest: AiDataRequest | null; exportAction: AiExportAction | null; visualReport: AiVisualReport | null; boardPatch: AiBoardPatch | null }
): AiToolName {
  if (actions.queryResults.length > 0) return 'query_dashboard_data';
  if (actions.dataRequest) return 'query_dashboard_data';
  if (actions.boardPatch) return 'compose_dashboard_ai_board';
  if (actions.visualReport) return 'suggest_visual_report';
  if (actions.exportAction?.type === 'dashboard-custom-workbook') return 'suggest_custom_workbook';
  if (actions.exportAction) return 'suggest_custom_workbook';
  const prompt = normalizePrompt(userPrompt);
  if (/\b(custom|rieng|workbook rieng|custom workbook)\b/.test(prompt)) return 'suggest_custom_workbook';
  if (/\b(ai workspace|workspace|whiteboard|board|canvas|bang trang|multi-season|three seasons|3 seasons)\b/.test(prompt)) return 'compose_dashboard_ai_board';
  if (/\b(visual|chart|graph|plot|ve|bieu do|peak hour)\b/.test(prompt)) return 'suggest_visual_report';
  if (/\b(export|download|excel|xlsx|report|bao cao|san luong|sanluong)\b/.test(prompt)) return 'suggest_custom_workbook';
  return 'query_dashboard_data';
}

function normalizePrompt(prompt: unknown): string {
  return String(prompt ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function isWorkspaceBoardIntent(prompt: unknown): boolean {
  const normalized = normalizePrompt(prompt);
  if (/\b(export|download|excel|xlsx)\b/.test(normalized)) return false;
  return /\b(ai workspace|workspace|whiteboard|board|canvas|bang trang|block board|multi-season|three seasons|3 seasons|so sanh 3 mua|compare selected seasons|visual|visual report|chart|graph|plot|ve|bieu do|dashboard visual|peak hour|table|bang|report dang bang|lap report dang bang|driver table|create driver table|draw peak hour chart|build visual report|build ai workspace board)\b/.test(normalized);
}

function isCompareSeasonsPrompt(normalizedPrompt: string): boolean {
  return /\b(compare selected seasons|multi-season|three seasons|3 seasons|so sanh 3 mua|selected seasons)\b/.test(normalizedPrompt);
}

function isDifferenceComparisonPrompt(normalizedPrompt: string): boolean {
  const hasComparison = /\b(so sanh|compare|comparison|vs|voi|with)\b/.test(normalizedPrompt);
  const hasDifference = /\b(khac biet|diem khac biet|noi bat|difference|differences|delta|change|changes|bien dong|tang|giam|drop|drivers?)\b/.test(normalizedPrompt);
  const hasPeriod = /\b(thang|month|week|tuan|period|\d{4}-\d{2})\b/.test(normalizedPrompt);
  const wantsTable = /\b(bang|table|report)\b/.test(normalizedPrompt);
  return (hasComparison && hasPeriod && (hasDifference || wantsTable)) || (hasDifference && wantsTable && hasPeriod);
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

function comparisonDifferenceBoardTitle(prompt: unknown): string {
  const normalized = normalizePrompt(prompt);
  const monthNumbers = Array.from(normalized.matchAll(/\bthang\s*(1[0-2]|0?[1-9])\b/g)).map((match) => Number(match[1]));
  if (monthNumbers.length >= 2) {
    return `Bảng khác biệt tháng ${monthNumbers[0]} vs tháng ${monthNumbers[1]}`;
  }
  const monthKeys = Array.from(normalized.matchAll(/\b(\d{4}-\d{2})\b/g)).map((match) => match[1]);
  if (monthKeys.length >= 2) {
    return `Bảng khác biệt ${monthKeys[0]} vs ${monthKeys[1]}`;
  }
  return 'Bảng so sánh khác biệt theo kỳ';
}

function comparisonDifferenceFilters(prompt: unknown): Record<string, string> {
  const normalized = normalizePrompt(prompt);
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

function visualTemplateTitle(templateId: AiVisualReportTemplateId): string {
  if (templateId === 'season-overview') return 'Season Overview';
  if (templateId === 'driver-waterfall') return 'Driver Waterfall';
  if (templateId === 'peak-hour') return 'Peak Hour';
  if (templateId === 'route-country') return 'Route Country';
  return 'Airline Mix';
}

function sanitizeTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((entry) => escapeFormulaText(sanitizeText(entry, '', 240)))
    .filter(Boolean);
}

function sanitizeText(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return normalized || fallback;
}

function sanitizeId(value: unknown, fallback: string): string {
  const normalized = sanitizeText(value, fallback, 60)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || fallback;
}

function escapeFormulaText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function sanitizeQueryTableData(rowsValue: unknown, columnsValue: unknown): {
  columns: string[];
  rows: Record<string, AiQueryCell>[];
} {
  const explicitColumns = Array.isArray(columnsValue)
    ? columnsValue.slice(0, 12).map((entry) => sanitizeText(entry, '', 64)).filter(Boolean)
    : [];
  const rows = sanitizeQueryRows(rowsValue, explicitColumns);
  const columns = explicitColumns.length > 0
    ? explicitColumns
    : rows.reduce<string[]>((nextColumns, row) => {
        for (const key of Object.keys(row)) {
          if (!nextColumns.includes(key)) nextColumns.push(key);
          if (nextColumns.length >= 12) break;
        }
        return nextColumns;
      }, []);
  return {
    columns,
    rows: columns.length > 0
      ? rows.map((row) => {
          const normalized: Record<string, AiQueryCell> = {};
          for (const column of columns) normalized[column] = sanitizeQueryCell(row[column]);
          return normalized;
        })
      : rows,
  };
}

function sanitizeQueryRows(value: unknown, preferredColumns: string[] = []): Record<string, AiQueryCell>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, AiQueryCell>[] = [];
  for (const rowValue of value.slice(0, 24)) {
    if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) continue;
    const raw = rowValue as Record<string, unknown>;
    const keys = preferredColumns.length > 0 ? preferredColumns : Object.keys(raw).slice(0, 12);
    const row: Record<string, AiQueryCell> = {};
    let hasValue = false;
    for (const key of keys) {
      const column = sanitizeText(key, '', 64);
      if (!column) continue;
      const cell = sanitizeQueryCell(raw[key]);
      row[column] = cell;
      if (cell !== null && cell !== '') hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

function optionalIsoDate(value: unknown): string | false | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value;
}

function optionalKeyList(value: unknown, validator: (entry: string) => boolean): string[] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  const list = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean);
  if (list.length > 24 || !list.every(validator)) return false;
  return [...new Set(list)];
}

function optionalTextList(value: unknown, uppercase: boolean): string[] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  return [...new Set(value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean)
    .map((entry) => uppercase ? entry.toUpperCase() : entry)
    .slice(0, 40))];
}

function optionalEnumList<T extends readonly string[]>(value: unknown, allowed: T): T[number][] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  const list = value
    .filter((entry): entry is T[number] => typeof entry === 'string' && (allowed as readonly string[]).includes(entry))
    .slice(0, 40);
  if (list.length !== value.length) return false;
  return [...new Set(list)];
}

function optionalIntegerList(value: unknown, min: number, max: number): number[] | false | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return false;
  const list = value
    .map((entry) => typeof entry === 'number' || typeof entry === 'string' ? Number(entry) : NaN)
    .filter((entry) => Number.isInteger(entry) && entry >= min && entry <= max)
    .slice(0, 40);
  if (list.length !== value.length) return false;
  return [...new Set(list)];
}

function optionalEnum<T extends readonly string[]>(value: unknown, allowed: T): T[number] | false | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T[number] : false;
}

function optionalPositiveInteger(value: unknown, cap: number): number | false | null {
  if (value == null || value === '') return null;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, cap) : false;
}

function optionalHour(value: unknown): number | null {
  const hour = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : null;
}

function isMonthKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

function isWeekKey(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 53;
}

function inferContextYear(context: unknown): number {
  const text = JSON.stringify(context ?? {});
  const match = /20\d{2}-\d{2}-\d{2}/.exec(text) ?? /20\d{2}-\d{2}/.exec(text);
  return match ? Number(match[0].slice(0, 4)) : new Date().getFullYear();
}

function inferPromptMonths(prompt: string, fallbackYear: number): string[] {
  const months = new Set<string>();
  for (const match of prompt.matchAll(/\b(?:thang|month)\s*(\d{1,2})\b/g)) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) months.add(`${fallbackYear}-${String(month).padStart(2, '0')}`);
  }
  for (const match of prompt.matchAll(/\b(20\d{2})-(\d{2})\b/g)) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) months.add(`${match[1]}-${match[2]}`);
  }
  return Array.from(months);
}

function selectedSeasonSetFromContext(context: unknown, options: { expandAdjacent?: boolean } = {}): string[] {
  const root = context && typeof context === 'object' && !Array.isArray(context) ? context as Record<string, unknown> : {};
  const multiSeason = root.multiSeasonCatalog && typeof root.multiSeasonCatalog === 'object' && !Array.isArray(root.multiSeasonCatalog)
    ? root.multiSeasonCatalog as Record<string, unknown>
    : {};
  const rawSeasonIds = Array.isArray(multiSeason.seasonIds)
    ? multiSeason.seasonIds
    : Array.isArray(multiSeason.seasons)
      ? (multiSeason.seasons as Array<Record<string, unknown>>).map((season) => season.seasonId)
      : [];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const value of rawSeasonIds) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push(normalized);
    if (selected.length >= 3) break;
  }
  if (!options.expandAdjacent || selected.length !== 1) return selected;
  const available = Array.isArray(root.availableSeasonCatalog)
    ? root.availableSeasonCatalog
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        seasonId: typeof entry.seasonId === 'string' ? entry.seasonId : '',
        seasonCode: typeof entry.seasonCode === 'string' ? entry.seasonCode : '',
        dateFrom: typeof (entry.dateRange as Record<string, unknown> | undefined)?.from === 'string' ? String((entry.dateRange as Record<string, unknown>).from) : '',
      }))
      .filter((entry) => entry.seasonId)
      .sort((left, right) => (left.dateFrom || left.seasonCode).localeCompare(right.dateFrom || right.seasonCode))
    : [];
  const index = available.findIndex((entry) => entry.seasonId === selected[0]);
  if (index < 0) return selected;
  const previous = available[index - 1]?.seasonId;
  const next = available[index + 1]?.seasonId;
  return (previous ? [previous, selected[0]] : next ? [selected[0], next] : selected).slice(0, 3);
}

function inferPromptDateRange(prompt: string, fallbackYear: string): { dateFrom: string; dateTo: string } | null {
  const normalized = normalizePrompt(prompt);
  const isoDates = Array.from(normalized.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((match) => match[1]);
  if (isoDates.length >= 2) return orderedDateRange(isoDates[0], isoDates[1]);
  const slashDates = Array.from(normalized.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g))
    .map((match) => toIsoDate(Number(match[1]), Number(match[2]), match[3]))
    .filter((date): date is string => Boolean(date));
  if (slashDates.length >= 2) return orderedDateRange(slashDates[0], slashDates[1]);
  const sameMonth = /\b(?:tu ngay|from)\s*(\d{1,2})\s*(?:den|to|-)\s*(?:ngay\s*)?(\d{1,2})\s*(?:thang|month)\s*(\d{1,2})(?:\/(20\d{2}))?\b/.exec(normalized);
  if (sameMonth) {
    const year = sameMonth[4] ?? fallbackYear;
    const start = toIsoDate(Number(sameMonth[1]), Number(sameMonth[3]), year);
    const end = toIsoDate(Number(sameMonth[2]), Number(sameMonth[3]), year);
    if (start && end) return orderedDateRange(start, end);
  }
  return null;
}

function toIsoDate(day: number, month: number, year: string): string | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !/^20\d{2}$/.test(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

function orderedDateRange(left: string, right: string): { dateFrom: string; dateTo: string } {
  return left <= right ? { dateFrom: left, dateTo: right } : { dateFrom: right, dateTo: left };
}

function inferPromptHours(prompt: string): { from: number; to: number } | null {
  const range = /\b(\d{1,2})\s*[-:]\s*(\d{1,2})\s*(?:am|pm)?\b/.exec(prompt);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from >= 0 && from <= 23 && to > from && to <= 24) return { from, to };
  }
  const single = /\b(\d{1,2})\s*(?:am|pm)\b/.exec(prompt);
  if (single) {
    const from = Number(single[1]);
    if (from >= 0 && from <= 23) return { from, to: from + 1 };
  }
  return null;
}

function buildToolDeclarations(body: AiRequestBody): GeminiFunctionDeclaration[] {
  const allowedTools = new Set(body.allowedTools?.length ? body.allowedTools : DEFAULT_ALLOWED_TOOLS);
  const declarations: GeminiFunctionDeclaration[] = [];
  if (allowedTools.has('query_dashboard_data')) {
    declarations.push({
      name: 'query_dashboard_data',
      description: 'Truy vấn read-only reporting.flight_operations với filter, groupBy và aggregate server-side.',
      parameters: {
        type: 'OBJECT',
        properties: {
          queryId: { type: 'STRING' },
          view: { type: 'STRING', enum: REPORTING_VIEWS },
          filters: {
            type: 'OBJECT',
            properties: {
              seasonIds: { type: 'ARRAY', items: { type: 'STRING' } },
              iataSeasonCodes: { type: 'ARRAY', items: { type: 'STRING' } },
              dateFrom: { type: 'STRING' },
              dateTo: { type: 'STRING' },
              months: { type: 'ARRAY', items: { type: 'STRING' } },
              weeks: { type: 'ARRAY', items: { type: 'STRING' } },
              isoweeks: { type: 'ARRAY', items: { type: 'STRING' } },
              weeknums: { type: 'ARRAY', items: { type: 'NUMBER' } },
              typeFilter: { type: 'STRING', enum: ['all', 'A', 'D'] },
              airlines: { type: 'ARRAY', items: { type: 'STRING' } },
              routes: { type: 'ARRAY', items: { type: 'STRING' } },
              countries: { type: 'ARRAY', items: { type: 'STRING' } },
              aircraft: { type: 'ARRAY', items: { type: 'STRING' } },
              acGroups: { type: 'ARRAY', items: { type: 'STRING' } },
              paxStatuses: { type: 'ARRAY', items: { type: 'STRING', enum: [...DASHBOARD_AI_PAX_STATUSES] } },
              localBuckets30: { type: 'ARRAY', items: { type: 'STRING' } },
              localBuckets60: { type: 'ARRAY', items: { type: 'STRING' } },
              utcBuckets30: { type: 'ARRAY', items: { type: 'STRING' } },
              utcBuckets60: { type: 'ARRAY', items: { type: 'STRING' } },
              localHourFrom: { type: 'NUMBER' },
              localHourTo: { type: 'NUMBER' },
            },
          },
          groupBy: { type: 'ARRAY', items: { type: 'STRING', enum: QUERY_GROUP_BY_COLUMNS } },
          metrics: { type: 'ARRAY', items: { type: 'STRING', enum: QUERY_METRICS } },
          orderBy: { type: 'STRING', enum: QUERY_ORDER_COLUMNS },
          limit: { type: 'NUMBER' },
        },
      },
    });
  }
  if (allowedTools.has('compose_dashboard_ai_board')) {
    declarations.push({
      name: 'compose_dashboard_ai_board',
      description: 'Tạo boardPatch cho AI Notebook với block whitelist: table, chart, kpi, insight-list, data-quality-notes, rich-markdown, html-preview.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          append: { type: 'BOOLEAN' },
          blocks: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'STRING' },
                type: { type: 'STRING', enum: WORKSPACE_BLOCK_TYPES },
                title: { type: 'STRING' },
                source: { type: 'STRING', enum: WORKSPACE_BLOCK_SOURCES },
                insights: { type: 'ARRAY', items: { type: 'STRING' } },
                table: { type: 'OBJECT' },
                chart: { type: 'OBJECT' },
                markdown: { type: 'OBJECT' },
                htmlPreview: { type: 'OBJECT' },
              },
            },
          },
        },
      },
    });
  }
  return declarations;
}

async function callGemini(
  model: AiModelSetting,
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  tools: GeminiFunctionDeclaration[] = [],
  toolContents: GeminiContent[] = []
): Promise<GeminiLlmResult> {
  const apiKey = Deno.env.get('DASHBOARD_AI_GEMINI_API_KEY');
  if (!apiKey) throw new Error('Gemini API key is not configured.');
  const contents: GeminiContent[] = [
    ...history.map((message): GeminiContent => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    { role: 'user', parts: [{ text: prompt }] },
    ...toolContents,
  ];
  const response = await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: DASHBOARD_AI_GROUNDING_INSTRUCTIONS }],
      },
      contents,
      ...(tools.length > 0 ? { tools: [{ function_declarations: tools }] } : {}),
    }),
  });
  const payload = await readJsonResponse<GeminiGenerateContentResponse>(response);
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const functionCallPart = parts.find((part) => Boolean(part.functionCall?.name));
  const functionCall = functionCallPart?.functionCall;
  if (functionCall?.name && functionCallPart && DEFAULT_ALLOWED_TOOLS.includes(functionCall.name as AiToolName)) {
    return {
      type: 'tool_call',
      toolCall: {
        name: functionCall.name as AiToolName,
        args: functionCall.args && typeof functionCall.args === 'object' ? functionCall.args : {},
      },
      modelPart: functionCallPart,
    };
  }
  const text = parts.map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty analysis response.');
  return { type: 'text', text };
}

async function callOpenAiCompatible(
  model: AiModelSetting,
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  const apiKeySecret = model.provider === 'deepseek'
    ? 'DASHBOARD_AI_DEEPSEEK_API_KEY'
    : 'DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY';
  const apiKey = Deno.env.get(apiKeySecret);
  if (!apiKey) {
    throw new Error(model.provider === 'deepseek'
      ? 'DeepSeek API key is not configured.'
      : 'OpenAI-compatible API key is not configured.');
  }
  if (!model.baseUrl) {
    throw new Error(model.provider === 'deepseek'
      ? 'DeepSeek base URL is not configured.'
      : 'OpenAI-compatible base URL is not configured.');
  }
  const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        { role: 'system', content: DASHBOARD_AI_GROUNDING_INSTRUCTIONS },
        ...history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const payload = await readJsonResponse<OpenAiCompatibleResponse>(response);
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI provider returned an empty analysis response.');
  return text;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(readErrorMessage(payload) ?? `AI request failed with HTTP ${response.status}`);
  }
  return payload as T;
}

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (typeof root.error === 'string') return root.error;
  if (root.error && typeof root.error === 'object') {
    const message = (root.error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return typeof root.message === 'string' ? root.message : null;
}

