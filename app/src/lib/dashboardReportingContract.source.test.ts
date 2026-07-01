import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = 'supabase/migrations/20260623090000_effective_dashboard_reporting.sql';
const aiReportingFields = [
  'isoweek',
  'weeknum',
  'local_bucket_30',
  'local_bucket_60',
  'utc_bucket_30',
  'utc_bucket_60',
  'ac_group',
  'pax_status',
] as const;
const reportingRpcSignatures = [
  'reporting.query_aggregated(jsonb, text[], text[], text, text, integer)',
  'public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer)',
  'public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer)',
] as const;
const dashboardAlertColumns = [
  ['dashboard_arrival_bucket_flights', 'integer'],
  ['dashboard_departure_bucket_flights', 'integer'],
  ['dashboard_ad_gap_flights', 'integer'],
  ['dashboard_ctg_abs_pct', 'numeric'],
  ['dashboard_pax_coverage_min_pct', 'numeric'],
] as const;

function readWorkspaceFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function assertContainsAll(source: string, terms: readonly string[], label: string): void {
  for (const term of terms) {
    assert.match(source, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${label}: missing ${term}`);
  }
}

function assertPaxMissingContract(source: string, label: string): void {
  assert.match(
    source,
    /coalesce\s*\(\s*b\.pax\s*,\s*0\s*\)\s*=\s*0[\s\S]{0,240}pax_missing_after_1_day/i,
    `${label}: pax_missing_after_1_day must treat null and zero pax as missing candidates`
  );
  assert.match(
    source,
    /when\s+coalesce\s*\(\s*b\.pax\s*,\s*0\s*\)\s*>\s*0\s+then\s+'reported'/i,
    `${label}: positive pax must be reported`
  );
  assert.match(
    source,
    /when\s+coalesce\s*\(\s*b\.pax\s*,\s*0\s*\)\s*=\s*0[\s\S]{0,240}then\s+'missing_after_1_day'/i,
    `${label}: zero pax must become missing_after_1_day after the threshold`
  );
  assert.match(source, /else\s+'planned_zero'/i, `${label}: zero pax before the threshold must be planned_zero`);
  assert.doesNotMatch(source, /missing_pending/i, `${label}: missing_pending is not part of the pax status contract`);
}

function assertRpcExecuteRevokedBeforeGrant(source: string, label: string): void {
  for (const signature of reportingRpcSignatures) {
    const revokePublic = source.indexOf(`revoke execute on function ${signature} from PUBLIC;`);
    const revokeAnon = source.indexOf(`revoke execute on function ${signature} from anon;`);
    const grantAuthenticated = source.indexOf(`grant execute on function ${signature} to authenticated;`);
    assert.notEqual(revokePublic, -1, `${label}: missing PUBLIC revoke for ${signature}`);
    assert.notEqual(revokeAnon, -1, `${label}: missing anon revoke for ${signature}`);
    assert.notEqual(grantAuthenticated, -1, `${label}: missing authenticated grant for ${signature}`);
    assert.ok(revokePublic < grantAuthenticated, `${label}: PUBLIC revoke must precede authenticated grant for ${signature}`);
    assert.ok(revokeAnon < grantAuthenticated, `${label}: anon revoke must precede authenticated grant for ${signature}`);
  }
}

function assertDashboardAlertColumns(source: string, label: string): void {
  for (const [column, type] of dashboardAlertColumns) {
    assert.match(source, new RegExp(`\\b${column}\\s+${type}\\b`, 'i'), `${label}: missing ${column} ${type}`);
  }
}

function assertDashboardAlertColumnMigration(source: string, label: string): void {
  const firstReportingView = source.indexOf('create or replace view reporting.effective_flight_operations');
  assert.notEqual(firstReportingView, -1, `${label}: missing reporting.effective_flight_operations view`);
  for (const [column, type] of dashboardAlertColumns) {
    const alterColumn = source.search(new RegExp(`alter\\s+table\\s+public\\.operational_settings[\\s\\S]*?add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\s+${type}\\b`, 'i'));
    assert.notEqual(alterColumn, -1, `${label}: missing alter add column for ${column} ${type}`);
    assert.ok(alterColumn < firstReportingView, `${label}: ${column} must be added before reporting views/functions`);
  }
}

function assertNoGroupAggregateRowCountContract(source: string, label: string): void {
  const queryAggregated = readSourceBlock(
    source,
    'create or replace function reporting.query_aggregated',
    'create or replace function public.dashboard_ai_query_aggregated',
    label
  );
  assert.match(
    queryAggregated,
    /if\s+array_length\s*\(\s*group_columns\s*,\s*1\s*\)\s+is\s+null\s+then\s+row_count\s*:=\s*1\s*;/i,
    `${label}: no-group aggregate must report the single aggregate result row`
  );
  assert.match(
    queryAggregated,
    /else[\s\S]{0,320}select\s+count\s*\(\s*\*\s*\)\s+from\s+\(\s*select\s+1\s+from\s+reporting\.flight_operations[\s\S]{0,220}group_clause[\s\S]{0,120}into\s+row_count\s*;/i,
    `${label}: grouped aggregate row_count must still count grouped result rows`
  );
  assert.match(
    queryAggregated,
    /'truncated'\s*,\s*array_length\s*\(\s*group_columns\s*,\s*1\s*\)\s+is\s+not\s+null\s+and\s+row_count\s*>\s*safe_limit/i,
    `${label}: no-group aggregate must not mark truncated from raw filtered row count`
  );
}

function readSourceBlock(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}: missing ${endMarker}`);
  return source.slice(start, end);
}

test('dashboard replacement UI labels are the active visible contract', () => {
  const dashboardPage = readWorkspaceFile('src/app/dashboard/page.tsx');
  const aiBlockRenderers = readWorkspaceFile('src/app/dashboard/components/AiNotebookBlockRenderers.tsx');
  const tabControls = readSourceBlock(dashboardPage, '<div className="mt-1 grid grid-cols-1', '<div className="text-left text-xs', 'dashboard tab controls');
  assertContainsAll(dashboardPage, ['Vận hành ca trực', 'So sánh sản lượng', 'AI Workspace'], 'dashboard page labels');
  assert.match(tabControls, /sm:grid-cols-3/, 'dashboard tabs must stack on small screens and keep three columns on wider screens');
  assert.match(tabControls, /min-h-11/, 'dashboard tab controls must keep usable touch target height');
  assert.match(dashboardPage, /xl:grid-cols-\[minmax\(160px,0\.9fr\)_minmax\(260px,1\.2fr\)_repeat\(2,minmax\(160px,1fr\)\)\]/, 'comparison filter grid must wrap into four stable columns instead of overflowing in one row');
  assert.doesNotMatch(dashboardPage, /repeat\(5,minmax\(130px/, 'comparison filter grid must not force all eight filters into one wide row');
  assert.match(
    tabControls,
    /Vận hành ca trực[\s\S]*So sánh sản lượng[\s\S]*AI Workspace/,
    'dashboard tabs must be ordered operations, comparison, AI Workspace'
  );
  assert.match(
    dashboardPage,
    /type\s+DashboardView\s*=\s*'operations'\s*\|\s*'comparison'\s*\|\s*'ai-workspace'/,
    'dashboard page view union must use operations/comparison/ai-workspace'
  );
  assert.doesNotMatch(dashboardPage, /Tổng quan|Phân tích MoM \/ WoW/, 'old dashboard tab labels must be removed');
  assert.doesNotMatch(dashboardPage, /h-screen|bg-gradient/, 'dashboard page must avoid fixed viewport height and decorative gradients');
  assert.doesNotMatch(aiBlockRenderers, /bg-gradient/, 'AI notebook rendered tables must not use gradient overlays');
  assert.match(dashboardPage, /max-h-\[420px\][^"]*overflow-auto[\s\S]{0,220}<table className="min-w-\[860px\]/, 'CTG ranking table must keep bounded scroll with a stable wide table');
  assert.match(dashboardPage, /min-w-\[720px\][\s\S]{0,260}comparisonDailyTrendRows/, 'daily trend chart must keep horizontal scan space on narrow screens');
  assert.match(aiBlockRenderers, /max-h-\[420px\] overflow-auto[\s\S]{0,120}<table className="min-w-\[720px\]/, 'AI workspace tables must keep bounded scroll and stable width');
  assert.match(dashboardPage, /<details key=\{card\.label\} open[\s\S]{0,220}<summary/, 'operational bucket drilldown cards must be collapsible with native details');
  assert.match(dashboardPage, /const\s+defaultOperationalDate\s*=\s*todayOperationalDate/, 'operational date must default to today instead of the last loaded flight date');
  assert.match(dashboardPage, /MONDAY_FIRST_WEEKDAY_COLUMNS[\s\S]{0,180}\{ key: 'Mon', label: 'T2' \}/, 'Peak Day heatmap must use a Monday-first calendar header');
  assert.match(dashboardPage, /mondayFirstOffset\(dates\[0\]\)/, 'Peak Day heatmap must insert leading blanks to align the month as a calendar');
  assert.match(dashboardPage, /value=\{activePeakDayMonth\}[\s\S]{0,180}setOperationalPeakDayMonth/, 'Peak Day heatmap must expose a month selector');
  assert.match(dashboardPage, /function\s+peakDayWeekTone[\s\S]{0,420}HEATMAP_CELL_TONES/, 'Peak Day heatmap must reuse the same color palette as Peak Hour');
  assert.match(dashboardPage, /weekMinFlights[\s\S]{0,160}weekMaxFlights/, 'Peak Day heatmap cells must carry weekly min/max for within-week color scaling');
  assert.match(dashboardPage, /weekMax[\s\S]{0,220}weekMin[\s\S]{0,220}weekMinFlights = weekMin[\s\S]{0,120}weekMaxFlights = weekMax/, 'Peak Day heatmap must scale colors by each Mon-Sun week');
  assert.match(dashboardPage, /Thấp trong tuần[\s\S]{0,180}Cao trong tuần[\s\S]{0,180}Số đỏ: cao nhất tháng/, 'Peak Day heatmap must explain low/high weekly color intensity and month high number color');
  assert.match(dashboardPage, /isMonthHigh[\s\S]{0,220}text-red-700/, 'Peak Day heatmap must render the month-high flight number in red');
  assert.match(dashboardPage, /operationalPeakHourTypeFilter/, 'Peak Hour heatmap must keep an independent type filter state');
  assert.match(dashboardPage, /<option value="A">Chuyến đến<\/option>[\s\S]{0,80}<option value="D">Chuyến đi<\/option>/, 'Peak Hour heatmap must expose arrival/departure filtering');
  assert.match(dashboardPage, /peakHourHeatmapMonths\.map[\s\S]{0,180}<details key=\{month\.key\}/, 'Peak Hour heatmap must render all season months as expandable groups');
  assert.match(dashboardPage, /formatValue\(flights\)/, 'Peak Hour heatmap cells must render the flight count inside non-empty buckets');
  assert.match(dashboardPage, /<details open>[\s\S]{0,360}Nhóm tác nhân/, 'CTG ranking table must be collapsible with native details');
  assert.match(dashboardPage, /<details open className="rounded-lg border[\s\S]{0,360}Drill-down tác nhân đã chọn/, 'selected driver drilldown must be collapsible with native details');
});

test('AI Workspace is decoupled from dashboard rows and local SQLite analytical context', () => {
  const dashboardPage = readWorkspaceFile('src/app/dashboard/page.tsx');
  const aiWorkspacePanel = readWorkspaceFile('src/app/dashboard/components/AiWorkspacePanel.tsx');
  const submitAiPrompt = readSourceBlock(dashboardPage, 'const submitAiPrompt', 'const aiWorkspaceSeasonSummaryRows', 'dashboard submitAiPrompt');
  const materializeTableRows = readSourceBlock(dashboardPage, 'const materializeAiWorkspaceTableRows', 'const materializeAiWorkspaceChartRows', 'AI Workspace table materializer');
  const materializeChartRows = readSourceBlock(dashboardPage, 'const materializeAiWorkspaceChartRows', 'const moveAiNotebookBlock', 'AI Workspace chart materializer');
  assert.doesNotMatch(dashboardPage, /buildDashboardAiContext/, 'dashboard page must not build AI context from dashboard comparison state');
  assert.doesNotMatch(dashboardPage, /selectedDriverRecordsForAi/, 'dashboard page must not send selected driver rows to AI Workspace');
  assert.doesNotMatch(dashboardPage, /queryNativeDashboardAiSql/, 'dashboard page must not execute local SQLite AI analytical queries');
  assert.doesNotMatch(dashboardPage, /analyzeDashboardWithLocalAgent|callNativeDashboardAiAgent/, 'dashboard page must not route AI Workspace through the local Python/local SQLite agent');
  assert.doesNotMatch(dashboardPage, /aiWaterfallRows|dashboardAiDataSourcePolicy/, 'dashboard page must not keep local/mixed dashboard context policy paths');
  assert.doesNotMatch(submitAiPrompt, /Python Agent|localAgent|isTauriRuntime\(\)/, 'submitAiPrompt must call the Edge Function/Supabase reporting path directly');
  assert.doesNotMatch(materializeTableRows, /overview\.|analysisRecords|resolveAiWorkspaceComparison/, 'AI Workspace table fallback must not read overview/comparison records');
  assert.doesNotMatch(materializeChartRows, /overview\.|analysisRecords|resolveAiWorkspaceComparison/, 'AI Workspace chart fallback must not read overview/comparison records');
  assert.match(materializeTableRows, /block\.table\?\.rows/, 'AI Workspace table blocks must prefer explicit rows');
  assert.match(materializeChartRows, /block\.chart\?\.rows/, 'AI Workspace chart blocks must prefer explicit rows');
  assert.match(materializeTableRows, /block\.source\s*===\s*'multiSeason'/, 'AI Workspace may materialize multiSeason summary rows');
  assert.match(materializeTableRows, /Ghi chú dữ liệu|sourceQueryId/, 'legacy AI Workspace table fallbacks must expose a data-quality/source note instead of dashboard rows');
  assert.match(dashboardPage, /currentQueryScope/, 'AI Workspace request context must send a visible currentQueryScope to the Edge Function');
  assert.match(aiWorkspacePanel, /Phạm vi/, 'AI Workspace panel must show the active query scope');
  assert.match(aiWorkspacePanel, /Từ ngày/, 'AI Workspace panel must expose a dateFrom control');
  assert.match(aiWorkspacePanel, /Đến ngày/, 'AI Workspace panel must expose a dateTo control');
  assert.match(aiWorkspacePanel, /Mùa chung toàn app/, 'AI Workspace panel must show the app-wide active season as read-only context');
  assert.doesNotMatch(aiWorkspacePanel, /Mùa đã chọn|tối đa 3|onToggleSeason|selectedSeasonIds\.length\s*>=\s*3/, 'AI Workspace must not keep a separate max-3 season picker');
  assert.doesNotMatch(dashboardPage, /selectedAiSeasonIds|toggleAiWorkspaceSeason/, 'AI Workspace must not manage a separate AI season selection state');
});

test('dashboard comparison scope, ranking, and legacy season state stay isolated', () => {
  const dashboardPage = readWorkspaceFile('src/app/dashboard/page.tsx');
  const comparisonSection = readSourceBlock(dashboardPage, "{dashboardView === 'comparison' &&", "{dashboardView === 'ai-workspace' &&", 'dashboard comparison section');
  assert.doesNotMatch(dashboardPage, /useSessionState<string\[\]>\('dashboard:seasonIds'/, 'operations/comparison must ignore hidden legacy dashboard:seasonIds state');
  assert.doesNotMatch(dashboardPage, /activeDashboardSeasonIds|dashboardSeasonOptions|toggleDashboardSeason/, 'legacy dashboard multi-season selectors must be removed from the new dashboard');
  assert.match(dashboardPage, /const\s+dashboardRecords\s*=\s*useMemo\s*\(\s*\(\)\s*=>\s*effectiveRecords\s*,\s*\[effectiveRecords\]\s*\)/, 'dashboardRecords must be scoped to the opened season effective records');
  assert.match(dashboardPage, /comparisonScopedRecords/, 'comparison must derive a current+previous scoped record set');
  assert.match(dashboardPage, /computePaxCoverage\(comparisonScopedRecords\)/, 'pax coverage warning must use the comparison-scoped records');
  assert.match(dashboardPage, /comparisonTrendRecords[\s\S]{0,180}dashboardRecords\.filter/, 'comparison trend charts must use the opened season records instead of current/previous scoped records');
  assert.match(dashboardPage, /summarizeComparisonRecordsByMonth\(comparisonTrendRecords,\s*metric\)/, 'comparison monthly trend must show all months in the opened season');
  assert.match(dashboardPage, /setComparisonTrendMonth\(row\.key\)/, 'clicking a monthly trend column must select that month for the daily trend');
  assert.match(dashboardPage, /monthDateKeys\(activeComparisonTrendMonth\)/, 'comparison daily trend must render all days in the selected month');
  assert.match(dashboardPage, /function\s+trendBarHeight/, 'trend bars must use a shared height helper instead of collapsing percentage spans');
  assert.match(dashboardPage, /comparisonMonthlyTrendRows\.map[\s\S]{0,260}className=\{`flex h-full/, 'monthly trend bar columns must have a fixed parent height for percentage bars');
  assert.match(dashboardPage, /comparisonDailyTrendRows\.map[\s\S]{0,260}className="flex h-full/, 'daily trend bar columns must have a fixed parent height for percentage bars');
  assert.doesNotMatch(comparisonSection, /overview\.monthlyTrend|overviewDailyCalendarRows|overviewMaxMonthlyFlights|overviewMaxDailyFlights/, 'comparison trend UI must not read old overview trend state');
  assert.match(dashboardPage, /ctgRankedDrivers[\s\S]{0,220}Math\.abs\(right\.ctgPct/, 'CTG ranking must sort by absolute CTG percentage magnitude');
  assert.match(comparisonSection, /ctgRankedDrivers\.slice\(0,\s*12\)/, 'Xếp hạng CTG table must render CTG-ranked drivers');
});

test('Supabase operational settings tolerate pre-dashboard-alert schemas', () => {
  const supabaseStore = readWorkspaceFile('src/lib/supabaseStore.ts');
  assertContainsAll(
    supabaseStore,
    [
      'OPERATIONAL_SETTINGS_BASE_SELECT',
      'OPERATIONAL_SETTINGS_DASHBOARD_ALERT_COLUMNS',
      'isMissingDashboardAlertColumnError',
      'readOperationalSettingsRowWithDashboardAlertFallback',
      'upsertOperationalSettingsRowWithDashboardAlertFallback',
      'toOperationalSettingsBaseRow',
    ],
    'operational settings compatibility fallback'
  );
  assert.match(
    supabaseStore,
    /select\(OPERATIONAL_SETTINGS_SELECT\)[\s\S]{0,420}isMissingDashboardAlertColumnError\(fullResult\.error\)[\s\S]{0,320}select\(OPERATIONAL_SETTINGS_BASE_SELECT\)/,
    'loading operational settings must retry with base columns when dashboard alert columns are missing'
  );
  assert.match(
    supabaseStore,
    /upsert\(toOperationalSettingsRow\(normalized\)[\s\S]{0,420}isMissingDashboardAlertColumnError\(fullResult\.error\)[\s\S]{0,420}upsert\(toOperationalSettingsBaseRow\(normalized\)/,
    'saving operational settings must retry with base columns when dashboard alert columns are missing'
  );
  assert.match(
    supabaseStore,
    /PGRST204\|42703\|column \.\* does not exist/i,
    'fallback must recognize Supabase/Postgres missing column errors'
  );
});

test('effective dashboard reporting migration exposes the reporting foundation', () => {
  assert.equal(existsSync(join(process.cwd(), migrationPath)), true, `${migrationPath} must exist`);
  const migration = readWorkspaceFile(migrationPath);

  assertContainsAll(
    migration,
    [
      'reporting.effective_flight_operations',
      'reporting.flight_operations',
      'public.season_flight_records',
      'public.season_modifications',
      'public.season_modification_added_legs',
      'changed_fields',
      'local_bucket_30',
      'local_bucket_60',
      'utc_bucket_30',
      'utc_bucket_60',
      'pax_missing_after_1_day',
      'pax_status',
      'weeknum',
      'isoweek',
      'ac_group',
      'operational_route_countries',
      'operational_aircraft_group_types',
      'operational_aircraft_groups',
      'dashboard_ai_query_rows',
      'dashboard_ai_query_aggregated',
      'reporting.query_aggregated',
    ],
    'effective reporting migration'
  );

  assert.match(migration, /status\s*<>\s*'deleted'|status\s+is\s+distinct\s+from\s+'deleted'/i);
  assert.doesNotMatch(migration, /\bnote\b/i, 'reporting contract must not expose note as a business status');
  assertPaxMissingContract(migration, 'effective reporting migration');
  assertRpcExecuteRevokedBeforeGrant(migration, 'effective reporting migration');
  assertDashboardAlertColumnMigration(migration, 'effective reporting migration');
  assertNoGroupAggregateRowCountContract(migration, 'effective reporting migration');
});

test('schema mirror contains effective reporting views and AI allowlists', () => {
  const schema = readWorkspaceFile('supabase/schema.sql');
  assertContainsAll(
    schema,
    [
      'reporting.effective_flight_operations',
      'create or replace view reporting.flight_operations as',
      'select * from reporting.effective_flight_operations',
      'local_bucket_30',
      'local_bucket_60',
      'utc_bucket_30',
      'utc_bucket_60',
      'pax_missing_after_1_day',
      'pax_status',
      'weeknum',
      'isoweek',
      'ac_group',
      'dashboard_ai_query_rows',
      'dashboard_ai_query_aggregated',
      'reporting.query_aggregated',
    ],
    'schema effective reporting contract'
  );
  assertPaxMissingContract(schema, 'schema effective reporting contract');
  assertRpcExecuteRevokedBeforeGrant(schema, 'schema effective reporting contract');
  assertDashboardAlertColumns(schema, 'schema effective reporting contract');
  assertNoGroupAggregateRowCountContract(schema, 'schema effective reporting contract');
});

test('AI query contracts name reporting.flight_operations and safe RPC entry points', () => {
  const edgeFunction = readWorkspaceFile('supabase/functions/dashboard-ai-analysis/index.ts');
  const sharedContract = readWorkspaceFile('supabase/functions/_shared/dashboardAiShared.ts');
  const combined = `${edgeFunction}\n${sharedContract}`;

  assertContainsAll(
    combined,
    ['reporting.flight_operations', 'dashboard_ai_query_rows', 'dashboard_ai_query_aggregated'],
    'AI query contract'
  );
  assertContainsAll(combined, ['reported', 'planned_zero', 'missing_after_1_day'], 'AI pax status contract');
  assert.doesNotMatch(combined, /missing_pending/i, 'AI pax status contract must not allow missing_pending');
});

test('AI Workspace Edge prompt and fallbacks require Supabase reporting query evidence', () => {
  const edgeFunction = readWorkspaceFile('supabase/functions/dashboard-ai-analysis/index.ts');
  const aiLib = readWorkspaceFile('src/lib/dashboardAiAnalysis.ts');
  const promptBuilder = readSourceBlock(edgeFunction, 'function buildDashboardAiPrompt', 'function inferExportAction', 'AI prompt builder');
  const frontendPromptBuilder = readSourceBlock(aiLib, 'export function buildDashboardAiPrompt', 'export async function analyzeDashboardWithAi', 'frontend AI stable prompt builder');
  const fallbackBuilder = readSourceBlock(edgeFunction, 'function defaultBoardPatchForPrompt', 'function workspaceKpiBlock', 'AI board fallback builder');
  const workspaceSources = readSourceBlock(edgeFunction, 'const WORKSPACE_BLOCK_SOURCES', 'const WORKSPACE_CHART_TYPES', 'AI workspace source allowlist');

  assert.doesNotMatch(promptBuilder, /local-sqlite|SQLite local|sqlQueryPlans|dashboard_ai_flight_operations|filter dashboard đang chọn/i, 'Edge prompt must not advertise local SQLite/sqlQueryPlans/dashboard-current context');
  assert.doesNotMatch(frontendPromptBuilder, /SQLite local|sqlQueryPlans SELECT\/CTE|local-sqlite|gateway validate/i, 'frontend stable prompt must not advertise local SQLite/sqlQueryPlans');
  assert.match(promptBuilder, /dataQueries[\s\S]{0,220}queryResults|queryResults[\s\S]{0,220}dataQueries/i, 'Edge prompt must require dataQueries/queryResults from Supabase reporting');
  assert.doesNotMatch(workspaceSources, /'overview'/, 'AI Workspace board source allowlist must not expose overview dashboard context');
  assert.doesNotMatch(fallbackBuilder, /workspace(?:Kpi|Chart|Table)Block\([^)]*'overview'|filter dashboard đang chọn|dashboard local/i, 'fallback board blocks must not use overview/dashboard-current context');
  assert.match(fallbackBuilder, /resolvedDataRequest/, 'fallback board blocks must prefer resolvedDataRequest/query-backed blocks');
  assert.match(fallbackBuilder, /multiSeason/, 'fallback board blocks may use multiSeason selected-season summaries');
  assert.match(fallbackBuilder, /custom-table/, 'fallback board tables without query evidence must stay custom-table/query placeholders');
});

test('AI reporting fields survive allowlist, sanitizer, and tool declaration paths', () => {
  const edgeFunction = readWorkspaceFile('supabase/functions/dashboard-ai-analysis/index.ts');
  const sharedContract = readWorkspaceFile('supabase/functions/_shared/dashboardAiShared.ts');
  const groupByAllowlist = readSourceBlock(
    sharedContract,
    'export const DASHBOARD_AI_QUERY_GROUP_BY_COLUMNS',
    'export const DASHBOARD_AI_QUERY_ORDER_COLUMNS',
    'AI shared group-by allowlist'
  );
  const normalizeQueryColumn = readSourceBlock(
    edgeFunction,
    'function normalizeQueryColumn',
    'function sanitizeExportAction',
    'AI normalizeQueryColumn sanitizer'
  );

  assertContainsAll(groupByAllowlist, aiReportingFields, 'AI shared group-by allowlist');
  if (!/QUERY_GROUP_BY_COLUMNS|NORMALIZED_QUERY_COLUMNS/.test(normalizeQueryColumn)) {
    assertContainsAll(normalizeQueryColumn, aiReportingFields, 'AI normalizeQueryColumn sanitizer');
  }
  if (/NORMALIZED_QUERY_COLUMNS/.test(normalizeQueryColumn)) {
    assert.match(
      edgeFunction,
      /NORMALIZED_QUERY_COLUMNS[\s\S]{0,240}QUERY_GROUP_BY_COLUMNS|QUERY_GROUP_BY_COLUMNS[\s\S]{0,240}NORMALIZED_QUERY_COLUMNS/,
      'AI normalizeQueryColumn sanitizer must derive NORMALIZED_QUERY_COLUMNS from QUERY_GROUP_BY_COLUMNS'
    );
  }
  assert.match(
    edgeFunction,
    /groupBy:\s*\{[\s\S]{0,180}enum:\s*QUERY_GROUP_BY_COLUMNS/,
    'AI tool declaration must expose QUERY_GROUP_BY_COLUMNS for groupBy'
  );
});

test('AI Workspace query scope contract is date-range first and not MCP based', () => {
  const sharedContract = readWorkspaceFile('supabase/functions/_shared/dashboardAiShared.ts');
  const edgeFunction = readWorkspaceFile('supabase/functions/dashboard-ai-analysis/index.ts');
  const dashboardPage = readWorkspaceFile('src/app/dashboard/page.tsx');

  assertContainsAll(
    sharedContract,
    [
      'DashboardAiQueryScope',
      'DASHBOARD_AI_QUERY_SCOPE_MAX_DAYS',
      'applyDashboardAiQueryScopeToDataQuery',
      'dashboardAiQueryScopeNeedsConfirmation',
      'sourcePreset',
    ],
    'AI Workspace query scope shared contract'
  );
  assert.match(sharedContract, /sourcePreset:\s*'selected-season'\s*\|\s*'user-date-range'\s*\|\s*'user-filter'\s*\|\s*'follow-up'/, 'query scope sourcePreset union must name selected season, user date range, user filter, and follow-up');
  assert.match(sharedContract, /scope\.sourcePreset\s*===\s*'selected-season'[\s\S]{0,260}presetSeasonIds/, 'selected season preset must only apply seasonIds when scope sourcePreset is selected-season');
  assert.match(sharedContract, /const queryHasExplicitSeason = Boolean/, 'query scope helper must detect explicit season or season-code filters');
  assert.match(sharedContract, /shouldApplySelectedSeasonPreset = scope\.sourcePreset === 'selected-season' && !queryHasExplicitPeriod && !queryHasExplicitSeason/, 'selected season preset must not constrain explicit date range or explicit season-code queries');
  assert.match(sharedContract, /whole db[\s\S]{0,160}toan bo db/, 'query intent helper must recognize all-DB prompts as data query intents');
  assert.match(dashboardPage, /requestDataScope\.scope === 'all-seasons-aggregate'[\s\S]{0,220}sourcePreset:\s*'user-filter'/, 'all-DB prompt scope must remove the selected-season preset before calling the Edge Function');
  assert.match(dashboardPage, /shouldLoadRequestSeasonData = requestDataScope\.scope !== 'all-seasons-aggregate'[\s\S]{0,140}requestSeasonIds\.length <= 6/, 'all-DB prompts must not fan out local/native season loads before Supabase reporting query');
  assert.doesNotMatch(`${sharedContract}\n${edgeFunction}\n${dashboardPage}`, /\bMCP\b|mcp server|mcp tool/i, 'AI Workspace V1 runtime must not add MCP as a data path');
  assert.match(edgeFunction, /applyDashboardAiQueryScopeToDataQuery/, 'Edge Function must apply currentQueryScope to dataQueries before execution');
  assert.match(edgeFunction, /dashboardAiQueryScopeNeedsConfirmation/, 'Edge Function must guard overly broad date ranges');
});
