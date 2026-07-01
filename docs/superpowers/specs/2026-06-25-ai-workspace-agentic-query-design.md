# AI Workspace Agentic Query Design - 2026-06-25

## Goal

Redesign `AI Workspace` into a Vietnamese-first analytical chat agent. The user can ask free-form operational questions, adjust data scope, and receive query-backed summaries, tables, charts, drill-downs, and next actions.

## Confirmed Boundary

- Supabase reporting RPCs are the canonical data source for AI Workspace.
- Python sidecars, local SQLite SQL plans, raw SQL, current dashboard rows, and fixed MoM/WoW payloads are not AI Workspace data sources.
- MCP is not part of the AI Workspace V1 runtime. The app should use the existing Edge Function and internal tool contract directly instead of adding an MCP layer.
- Date range is the primary query scope.
- The selected season is only the default context preset when the user has not supplied a stronger scope.
- If an answer needs data that cannot be queried through current reporting views/RPC filters, AI Workspace must say so clearly instead of guessing.

## Current Findings

- The current code already protects the broad boundary: dashboard source tests reject `queryNativeDashboardAiSql`, local Python agent routing, selected driver rows, and dashboard fallback rows in AI Workspace.
- The current UI still feels preset/report-led: season pills, report presets, and hidden scope are more prominent than direct date-range and scope controls.
- The shared query schema supports several useful filters today: season ids, IATA season code, date range, month/week, ARR/DEP type, airline, route, country, aircraft, PAX status, local hour, and grouped aggregate queries.
- Some docs were stale and still described desktop local agent/SQLite as the primary path. Those notes have been corrected to the confirmed boundary.

## Target Workflow

1. User enters a natural-language question in the AI Workspace composer.
2. Frontend builds an `AiQueryScope` from the visible context selector and selected season preset.
3. The Edge Function receives the question, chat memory, compact season catalog, and current scope.
4. Intent resolution classifies the request and either:
   - creates one or more read-only `dataQueries`, or
   - returns a clear unsupported/no-data response when the data slice cannot be served.
5. Supabase reporting RPCs execute the query plan:
   - `public.dashboard_ai_query_aggregated` for grouped metrics.
   - `public.dashboard_ai_query_rows` for bounded detail rows.
6. The backend profiles query results, checks narrative numbers against query evidence, and returns an answer with `queryResults`, `resultProfiles`, `toolTraceSummary`, and optional rich blocks.
7. The notebook renders a multi-turn chat cell with summary, evidence, tables/charts, drill-down controls, and follow-up suggestions.
8. Follow-up questions inherit the active artifact scope unless the user changes scope explicitly in the question or selector.

## UX Contract

The AI Workspace first viewport should make the active query scope visible and editable:

- A context bar above the chat composer shows the active scope, for example `Phạm vi: S26 | 01/04/2026 - 31/10/2026 | Tất cả chuyến`.
- The app-wide active season initializes the default scope, but date range controls and natural-language filters are the primary query controls.
- AI Workspace must not keep a separate season picker or max-season selection limit; a prompt can query across the reporting database when the requested date range/filter is supported.
- Scope controls should support:
  - date range,
  - season preset,
  - flight,
  - airport or route when supported by reporting filters,
  - ARR/DEP and status filters,
  - airline, country, aircraft, PAX status, local hour,
  - report data source or business slice when supported.
- The composer remains a free-text question box, not a report form.
- Loading states should show stages: understanding intent, planning query, fetching reporting data, profiling, composing answer.
- Error states should separate provider error, query error, permission error, unsupported scope, and timeout/range guardrail.
- Empty/no-data states should show the exact queried scope and suggest widening date range or removing filters.
- Partial result states should show the executed subset, omitted rows/ranges, and a safe next action such as `Mở rộng date range` or `Xem chi tiết`.
- Result blocks should support:
  - short summary,
  - evidence table,
  - chart when useful,
  - drill-down action based on `sourceQueryId`,
  - next follow-up prompts.

## Service Contract

Use an explicit contract between frontend, Edge Function, and reporting query layer:

```ts
type AiQueryScope = {
  dateFrom?: string;
  dateTo?: string;
  presetSeasonIds?: string[];
  iataSeasonCodes?: string[];
  flightNumbers?: string[];
  airports?: string[];
  routes?: string[];
  statuses?: string[];
  allocations?: string[];
  airlines?: string[];
  countries?: string[];
  aircraft?: string[];
  paxStatuses?: string[];
  localHourFrom?: number;
  localHourTo?: number;
  sourcePreset: 'selected-season' | 'user-date-range' | 'user-filter' | 'follow-up';
};

type AiIntentPlan = {
  intent: string;
  confidence: number;
  scope: AiQueryScope;
  queries: DashboardAiDataQuery[];
  requiresConfirmation?: boolean;
  unsupportedReason?: string;
};
```

Rules:

- Frontend sends `currentScope`, compact season catalog, and bounded chat memory.
- Edge Function owns intent resolution and query execution.
- Do not add an MCP server/tool bridge for V1; it adds another runtime surface without improving the data boundary.
- Provider prompts may request `dataQueries`, but the backend validates every query against scope and guardrails.
- Query result rows must carry `sourceQueryId`; rich blocks must reference that id.
- Frontend should not fabricate tables/charts when no matching query result exists.
- No mock data can satisfy a data-backed answer.

## Guardrails

- Require confirmation or return a range warning when date range exceeds the configured maximum.
- Enforce RPC row limits and use pagination/drill-down for detail rows.
- Prefer aggregate RPCs for broad ranges.
- Timeout query execution and return partial results when available.
- Never expose raw SQL or reporting schema internals to the user as an action they must run.
- Do not answer numerical questions without at least one successful query result or a clear no-data/unsupported explanation.

## Implementation Slices

1. Contract tests: lock the canonical Supabase reporting boundary and reject Python/SQLite/local dashboard fallbacks.
2. Query scope model: add explicit `AiQueryScope`, visible default selected-season scope, and date-range-first controls.
3. Intent and plan layer: normalize natural language into `AiIntentPlan` and validated `DashboardAiDataQuery` objects.
4. Backend guardrails: max range, limit, timeout, unsupported filters, partial result metadata.
5. Rich chat UI: context bar, staged loading, no-data/error/partial states, tables/charts/drill-downs, follow-up scope inheritance.
6. Docs/settings cleanup: remove local agent first wording from AI Workspace surfaces and keep provider/runtime guidance aligned with Edge Function; do not introduce MCP runtime docs for V1.
7. Verification: run source contract tests, shared query tests, lint/build where practical, and manual sample prompts against real Supabase reporting.

## Verification Prompts

- `Tóm tắt mùa chung toàn app theo tháng, kèm top 10 route theo số chuyến.`
- `Từ 01/06/2026 đến 15/06/2026, ngày nào cao điểm nhất và driver chính là gì?`
- `So sánh ARR/DEP của VN trên route SGN-HAN trong tuần 24.`
- `Liệt kê các chuyến bị thiếu PAX trong 7 ngày gần nhất của scope hiện tại.`
- `Từ bảng trên, drill-down riêng ngày cao điểm và vẽ chart theo local hour.`
- `Mở rộng phân tích đó sang cả S25 và S26 nếu có dữ liệu.`

## Open Risks

- Some requested filters, such as airport, allocation, or operational status, may need reporting view/RPC allowlist expansion if the current reporting layer does not expose them yet.
- Live verification depends on deployed migrations for `reporting.query_aggregated` and `public.dashboard_ai_query_aggregated`.
- Existing Python/SQLite files may remain in the repository until a separate cleanup slice removes obsolete runtime code safely.
