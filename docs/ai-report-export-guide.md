# AI Workspace Query-Only Report Export Guide

## Purpose

Dashboard AI runs as a Vietnamese-first rich chat inside `/dashboard`. It can answer with text, inline tables, Recharts charts, insights, data-quality notes, sandboxed static HTML preview, and local Excel export actions. It cannot write arbitrary files or mutate operational data.

AI Workspace is query-only and independent from the fixed MoM/WoW dashboard panel. The normal Dashboard still renders Overview and MoM/WoW analysis, but the AI no longer receives `comparison`, `waterfallRows`, selected driver state, or `comparison-drivers` fallback blocks. For analysis prompts, the AI plans read-only Supabase reporting queries, profiles the results, verifies the answer, and renders rich chat artifacts from query results.

## Backup Before AI Agent Changes

Before changing this integration, create a timestamped backup under `_backups/<feature>-YYYYMMDD-HHmmss/` with `app/src`, `app/supabase`, `app/scripts`, `app/package*.json`, `docs`, `context.md`, and `AGENTS.md`. Include `BACKUP_MANIFEST.md` with creation time, source path, git status when available, and included paths.

## Agent Runtime

V1 runs as a dashboard-only, read-only agent workflow:

- Owner workflow: `dashboard-report-analysis`
- Max provider rounds: `4` from the frontend request, clamped to `1-6` inside the Edge Function.
- Required gates: AI model configured, operator auth, app-wide active season for the default preset, local records, export eligibility, context-size cap, and allowed tool list.
- Allowed tools: `query_dashboard_data`, `suggest_custom_workbook`, `suggest_visual_report`, `compose_dashboard_ai_board`
- Tool definitions include `toolset`, `requires`, runtime `availability`, and optional `disabledReason`.
- The frontend now carries a Skawld-inspired run ledger. Each assistant cell can persist bounded `DashboardAiRunEvent` entries for user/tool/result/error phases, while `buildDashboardAiSessionLedger()` compacts old events before provider context is assembled.
- Tool permission is explicit: `evaluateDashboardAiToolPermission()` denies tools outside `allowedTools`, caps read-only query limits, and marks non-read-only export-style actions as confirmation-required. `scheduleDashboardAiRun()` groups parallel-safe read-only calls and records rejected calls with Vietnamese reasons.

Normal dashboard views still resolve summaries from local `effectiveRecords`. AI Workspace is query-first for ad-hoc analysis:

- AI Workspace uses `query_dashboard_data` against Supabase reporting RPCs as the canonical data path.
- Date range is the primary query scope. The app-wide active season is the default preset only when the prompt does not provide an explicit date range or broader scope.
- Python sidecars, local SQLite SQL plans, raw SQL, current dashboard rows, and fixed MoM/WoW payloads are not AI Workspace data sources.
- MCP is not part of the AI Workspace V1 runtime; use the Edge Function and internal read-only tool contract directly.
- Provider/service keys stay server-side in Edge Functions.
- Query results are profiled locally for coverage, null/distinct counts, metric stats, top contributors, and outlier candidates.
- Before rendering, answer verification checks key numbers in the narrative against query results/profile. If they mismatch, the UI shows a Vietnamese warning or uses deterministic fallback text/blocks.

## Vietnamese-First Output Policy

All user-facing AI presets and results must be Vietnamese:

- preset labels and prompt templates
- `assistantText`
- notebook block titles
- table headers
- chart/table insights
- data-quality notes
- loading/status text
- `toolTraceSummary.reason`
- deterministic fallback narratives

Internal ids remain English for stability: tool names, template ids, `boardPatch`, `resolvedDataRequest`, ARR/DEP, MoM/WoW, KPI, airline codes, and route codes.

## Hermes-Inspired Skills

The app uses Hermes-style procedural skills as local configuration only. It does not import the Python `hermes-agent` runtime.

The app also borrows Skawld SDK patterns for event streams, permissions, session ledgers, tool scheduling, and compaction. This is a pattern port, not a production runtime import. The optional compatibility check is `npm run check:skawld`; production `app/src` must not import `@skawld/agent-sdk`.

Current dashboard/query skills:

- `month-comparison-drivers`: month-vs-month driver table and waterfall by airline/route.
- `day-vs-baseline-drivers`: compare a peak day or referenced day against the rest-of-period baseline by airline, route, hour, ARR/DEP, type, country, or aircraft.
- `peak-day-anomaly`: find daily peak/outlier days and request baseline/drilldown queries in the same run.
- `route-pax-ranking`: rank routes by PAX with requested date/month filters.
- `flight-detail-investigation`: find one flight/day/detail row from the local SQL view.
- `season-to-season-frequency`: compare airline/route frequency across selected or explicitly named seasons.
- `peak-hour-analysis`: peak-hour chart and table.
- `route-country-report`: route/country ranking table and chart.
- `airline-mix-report`: airline ranking and mix analysis.
- `season-overview-report`: KPI strip, monthly trend, season summary, and insights.

The AI chooses the report shape and explanatory text. The app materializes numbers from query results, not from the fixed MoM/WoW panel.

## Prompt Assembly

Prompt assembly is layered:

- `STABLE_AGENT_CONTRACT`: language policy, grounding, safety rules, toolsets, available tools, skills, and whitelisted block/table/chart types.
- `LANGUAGE_POLICY`: explicit `language: vi` and Vietnamese-only user-facing output rules.
- `EPHEMERAL_DASHBOARD_CONTEXT`: selected skill, context profile, notebook memory summary, and provider fallback flag.
- `DASHBOARD_CONTEXT_JSON`: compact dashboard context plus optional `queryResults`, SQL plans, result profiles, and active chat artifact.

Notebook memory lite summarizes the latest cells by prompt, assistant summary, block titles/types, filters, app-wide active season context, and tool traces. It does not include rendered table rows or raw records.

## Supported Templates

- `mom-wow-analysis`: compact analysis workbook for the current MoM/WoW dashboard view.
- `sanluong-summary`: larger SanLuong-style workbook with raw data plus generated summary sheets.

Both templates export `.xlsx` files. V1 creates deterministic summary sheets, not native Excel pivot-table XML. When the prompt needs a different spreadsheet shape, the AI may suggest a bounded `dashboard-custom-workbook` spec that is sanitized before download.

## Canonical Data Columns

The SanLuong-style raw `Data` sheet uses this column order:

```text
Type
Flight
Config
STA/STD
Routes
Pax
Note
Airlines
Ops Date
Country
Weeknum
UTC
HourUTC
A/C Type
DayIndex
Weekday
IsoWeek
```

The app derives these values from active `FlightRecord` rows and excludes deleted records. Country is resolved through the operational settings route-country mapping. `UTC` and `HourUTC` are derived from local +7 schedule time.

## Workbook Shapes

`mom-wow-analysis` includes:

- `Report Guide`
- `Summary`
- `Drivers`
- `Waterfall`
- `Selected Records`
- `AI Notes`

`sanluong-summary` includes:

- `Report Guide`
- `Data`
- `Airline`
- `Country`
- `Routes`
- `Frequency`
- `Month`
- `Week`
- `PeakHour`
- `Per30min`
- `30days`
- `ACType`

The summary sheets are pivot-style outputs generated in code, so they open consistently in the packaged Tauri app without needing Excel automation.

## Query-Only Data Context

The normal rich-chat request includes the app-wide active season context, source policy, compact season catalog, active chat artifact, and recent bounded query samples. It does not include fixed MoM/WoW `comparison` or `waterfallRows`.

If the user asks about months, weeks, exact date ranges, route, airline, country, aircraft, PAX, peak hour, cross-season, consecutive seasons, one day, or one specific flight, the preferred path is a query-backed workflow. Client helpers infer semantic intent in Vietnamese/English, resolve an explicit scope, and request `query_dashboard_data` against Supabase reporting.

Grouped/aggregate queries are executed through `public.dashboard_ai_query_aggregated`, a Data API exposed `security invoker` wrapper that delegates to `reporting.query_aggregated` over `reporting.flight_operations`. This performs `GROUP BY`, `count(*)`, `sum(pax)`, ARR counts, and DEP counts in Postgres, avoiding the old Edge-side aggregation over a 500-row cap. Detail queries without `groupBy` remain bounded row reads.

Legacy `dataRequest` / `resolvedDataRequest` shapes remain only as compatibility transport. AI Workspace rejects them for new query intents so it cannot fall back to the current MoM/WoW table by accident.

## Safe AI Export Action Contract

The Edge Function may return this optional structure:

```json
{
  "type": "dashboard-template-export",
  "templateId": "mom-wow-analysis",
  "format": "xlsx",
  "fileName": "mom-wow-analysis.xlsx"
}
```

Allowed combinations are only:

- `templateId: "mom-wow-analysis"`, `fileName: "mom-wow-analysis.xlsx"`
- `templateId: "sanluong-summary"`, `fileName: "sanluong-summary.xlsx"`

Custom workbook actions use this shape:

```json
{
  "type": "dashboard-custom-workbook",
  "format": "xlsx",
  "fileName": "custom-summary.xlsx",
  "workbookSpec": {
    "title": "Custom Summary",
    "sheets": [
      {
        "name": "Summary",
        "columns": ["Airline", "Flights"],
        "rows": [{ "Airline": "VJ", "Flights": 12 }]
      }
    ]
  }
}
```

Custom workbooks are capped at 8 sheets, 20 columns per sheet, and 2,000 total rows. Cell values must be primitive values only. Formula-like text is escaped, and paths, macros, scripts, external links, unknown formats, and arbitrary file writes are ignored.

## Visual Report Action Contract

For visual requests, the Edge Function may return a `visualReport` spec or a notebook-first `boardPatch`. The app validates the spec and renders it with existing dashboard React/Recharts blocks. AI output is not executed as HTML, JavaScript, SQL, or script code.

Allowed visual templates:

- `season-overview`
- `driver-waterfall`
- `peak-hour`
- `route-country`
- `airline-mix`

Allowed block types:

- `kpi-summary`
- `monthly-trend`
- `driver-waterfall`
- `peak-hour`
- `route-country-ranking`
- `airline-mix-ranking`
- `insight-notes`

Example:

```json
{
  "templateId": "peak-hour",
  "title": "Peak Hour Visual",
  "filters": {
    "comparisonMode": "mom",
    "metric": "flights",
    "typeFilter": "D",
    "dimension": "hourBucket",
    "timeBasis": "utc"
  },
  "blocks": [
    {
      "id": "peak-hour",
      "type": "peak-hour",
      "title": "UTC Peak Hour",
      "source": "overview",
      "limit": 12
    }
  ],
  "insights": ["DEP wave concentrates in the selected peak-hour buckets."],
  "dataQualityNotes": ["Uses active dashboard filters and local effective records."]
}
```

The frontend caps blocks and text, strips unsafe fields, escapes formula-like insight text, and rejects unknown templates or block types.

## Native Tool Calling

Gemini-compatible providers can use native `function_declarations` for:

- `query_dashboard_data`
- `compose_dashboard_ai_board`

The Edge Function runs a bounded loop, feeds query results back to Gemini, and stops on final text, terminal board composition, or max rounds. OpenAI-compatible/Qwen-style providers keep the text JSON fallback path, so they do not need native tool support.

## Notebook Board Patch Contract

`compose_dashboard_ai_board` returns inline notebook blocks:

```json
{
  "title": "Bảng so sánh tháng 6 vs tháng 5",
  "blocks": [
    {
      "id": "drivers",
      "type": "table",
      "title": "Bảng điểm khác biệt nổi bật",
      "source": "comparison",
      "table": {
        "templateId": "comparison-drivers",
        "title": "Bảng điểm khác biệt nổi bật",
        "columns": ["label", "current", "previous", "delta", "deltaPct"],
        "source": "comparison",
        "filters": { "comparisonMode": "mom", "currentMonth": "06", "previousMonth": "05", "dimension": "airline" },
        "limit": 12
      }
    }
  ],
  "append": false
}
```

Allowed notebook block types: `kpi`, `table`, `chart`, `insight-list`, `data-quality-notes`.

Allowed chart types: `bar-ranking`, `line-trend`, `waterfall`, `heatmap`, `kpi-strip`.

Allowed table templates: `season-summary`, `comparison-drivers`, `monthly-trend`, `airline-ranking`, `route-country-ranking`, `peak-hour`, `multi-season-summary`.

If the provider returns text-only output or a `visualReport`, the frontend synthesizes context-aware fallback blocks. Month comparison prompts such as `tạo bảng so sánh các điểm khác biệt nổi bật của tháng 6 với tháng 5` must render `comparison-drivers` and waterfall blocks for the inferred periods.

## Tool Trace Summary

The Edge Function may include `toolTraceSummary` so operators can see why the agent chose a tool. Only whitelisted tool names and statuses are accepted:

```json
[
  {
      "tool": "suggest_visual_report",
      "status": "accepted",
      "reason": "Prompt yêu cầu báo cáo trực quan peak hour."
  }
]
```

Trace entries may also include `skill`, `toolset`, `fallbackReason`, `contextProfile`, and `providerAttempt`. Unknown tools, write-file actions, and arbitrary execution requests are dropped.

## Provider Runtime

AI Workspace provider calls go through the Supabase Edge Function `dashboard-ai-analysis`. The Edge Function keeps provider secrets server-side, infers query scope, executes allowlisted Supabase reporting RPCs, and returns the rich response contract used by the notebook/chat renderer.

Python local agents and local SQLite query plans are deprecated for AI Workspace and must not be presented as current analytical sources.

## Provider Retry

The frontend may retry one transient provider failure (`408`, `429`, `500`, `502`, `503`, `504`, timeout, temporary service unavailable). It must not retry malformed schema responses, auth failures, safety rejections, missing model configuration, or invalid Edge Function contracts. Successful retry traces are annotated with `providerAttempt: 2`.

## Deploy Caveat

`npm run test:rules`, lint, and build verify source-side contracts only. `reporting.query_aggregated` and `dashboard_ai_query_aggregated` are database migrations and must be applied separately before live aggregate correctness is available. If live AI Workspace behavior changes, deploy the `dashboard-ai-analysis` Edge Function after source verification and migration pass.

## Future Native Pivot Upgrade

The reference files in `docs/report_ref` contain real Excel pivot tables. Creating those reliably from browser-side SheetJS is not practical in v1. If native pivots become required, use a template-preserving harness:

1. Keep a sanitized reference workbook as a template.
2. Replace only the raw `Data` table.
3. Preserve pivot cache/table XML and workbook relationships.
4. Set pivots to refresh when opened in Excel.
5. Verify the generated workbook by opening it in Excel and refreshing all pivots.
