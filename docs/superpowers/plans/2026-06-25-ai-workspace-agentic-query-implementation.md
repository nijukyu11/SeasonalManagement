# AI Workspace Agentic Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make AI Workspace behave as a query-backed rich chat agent with visible date-range-first scope, Supabase reporting RPCs as the only analytical data source, and no MCP/Python/SQLite runtime path in V1.

**Architecture:** Keep the existing `dashboard-ai-analysis` Edge Function as the single AI runtime. Add an explicit `DashboardAiQueryScope` contract to the shared AI query layer, send it from the dashboard UI, let the Edge Function apply it to inferred/provider `dataQueries`, and render the active scope in the AI Workspace context bar. Keep all data fetches behind `dashboard_ai_query_rows` and `dashboard_ai_query_aggregated`.

**Tech Stack:** Next.js/React/TypeScript, Supabase Edge Functions, Node source-contract tests, existing dashboard notebook renderers.

---

### Task 1: Lock Agentic Query Boundary With Failing Source Tests

**Files:**
- Modify: `app/src/lib/dashboardReportingContract.source.test.ts`

- [x] **Step 1: Write failing tests**

Add assertions that require:
- `DashboardAiQueryScope` and `applyDashboardAiQueryScopeToDataQuery` in `supabase/functions/_shared/dashboardAiShared.ts`.
- `currentQueryScope` in `app/src/app/dashboard/page.tsx`.
- `Phạm vi`, `Từ ngày`, and `Đến ngày` in `app/src/app/dashboard/components/AiWorkspacePanel.tsx`.
- No `sqlQueryPlans SELECT/CTE cho SQLite local` wording in the Edge prompt builder.

- [x] **Step 2: Run red verification**

Run: `npm run test:dashboard-contract` from `app`.

Expected: FAIL because the new contract markers do not exist yet.

### Task 2: Add Shared Query Scope Contract

**Files:**
- Modify: `app/supabase/functions/_shared/dashboardAiShared.ts`

- [x] **Step 1: Implement minimal scope types and helpers**

Add:
- `DashboardAiQueryScope`.
- `DASHBOARD_AI_QUERY_SCOPE_MAX_DAYS`.
- `applyDashboardAiQueryScopeToDataQuery(query, scope)`.
- `dashboardAiQueryScopeNeedsConfirmation(scope)`.

Rules:
- Explicit query date/month/week filters win over default selected-season date scope.
- Scope filters merge into query filters only when the query did not already specify that filter.
- Date range wider than the max guardrail reports confirmation needed.

- [x] **Step 2: Run green verification**

Run: `npm run test:dashboard-contract` from `app`.

Expected: still may fail until UI/Edge markers are implemented; shared-contract assertions should pass.

### Task 3: Send Visible AI Query Scope From Dashboard UI

**Files:**
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/dashboard/components/AiWorkspacePanel.tsx`

- [x] **Step 1: Add scope state**

Add dashboard state for `aiQueryScopeDateFrom` and `aiQueryScopeDateTo`, initialized from the app-wide active season date range when no explicit date range exists.

- [x] **Step 2: Add context bar UI**

Show:
- `Phạm vi` summary.
- Read-only `Mùa chung toàn app` context.
- `Từ ngày` date input.
- `Đến ngày` date input.
- `Đặt theo mùa đang chọn` action.

- [x] **Step 3: Include scope in AI context**

Pass `currentQueryScope` into `buildDashboardAiQueryOnlyContext()` and `analyzeDashboardWithAi()` context.

- [x] **Step 4: Run source verification**

Run: `npm run test:dashboard-contract` from `app`.

Expected: Edge wording assertions may still fail until Task 4.

### Task 4: Apply Scope And Remove Stale SQLite Prompting In Edge Path

**Files:**
- Modify: `app/supabase/functions/dashboard-ai-analysis/index.ts`
- Modify: `app/src/lib/dashboardAiAnalysis.ts`

- [x] **Step 1: Remove stale local SQL wording**

Change the prompt/safety contract so AI Workspace says only Supabase reporting `dataQueries`, no local SQLite SQL plans.

- [x] **Step 2: Apply `currentQueryScope` to inferred/provider data queries**

When the Edge Function infers or sanitizes a data query, merge `currentQueryScope` into the query before execution.

- [x] **Step 3: Add guardrail trace**

If a date range is too wide, return a clear data-quality note or rejected tool trace instead of silently running an unbounded query.

- [x] **Step 4: Run source verification**

Run: `npm run test:dashboard-contract` from `app`.

Expected: PASS.

### Task 5: Final Verification And Docs Check

**Files:**
- Existing docs/spec already updated in this branch.

- [x] **Step 1: Run rule tests**

Run: `npm run test:rules` from `app`.

Expected: PASS.

- [x] **Step 2: Scan Vietnamese docs for mojibake**

Run the AGENTS.md mojibake marker scan against `context.md`, `docs/ai-report-export-guide.md`, the AI Workspace spec, this plan, and the edited AI Workspace source files.

Expected: no matches.

