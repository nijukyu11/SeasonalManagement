# Operational Dashboard Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `Tổng quan` and `Phân tích MoM / WoW` dashboard views with operational dashboards that read the same effective Supabase reporting data used by Daily Schedule, while keeping `AI Workspace` query-only and independent from dashboard UI context.

**Architecture:** Build a canonical effective reporting layer in Supabase first, then make both dashboard UI and AI Workspace query that layer. The frontend keeps the existing server-window refresh boundary, but the dashboard analytics are split into operational monitoring and sản lượng comparison modules so the UI no longer depends on the old overview/comparison widgets. AI Workspace receives season metadata and user prompt only; every agent analysis resolves rows or aggregates through allowlisted Supabase reporting RPCs.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind, Supabase Postgres views/RPCs, Supabase Edge Function `dashboard-ai-analysis`, Node source-regression tests, Node TypeScript tests.

---

## Confirmed Decisions

- Replace exactly two dashboard views:
  - `Tổng quan` -> `Vận hành ca trực`
  - `Phân tích MoM / WoW` -> `So sánh sản lượng`
  - Keep `AI Workspace`, but it must not consume dashboard context or selected dashboard rows.
- Source of truth is Supabase server data, not Excel workbook pivots and not dashboard in-memory context.
- The dashboard and AI must query effective schedule data: base records plus server-applied add/edit/delete, excluding deleted records.
- Operational date is local airport operational day: `05:00` to `04:59` next calendar day.
- UTC toggle keeps the same operational window and shifts bucket labels only.
- Operational timelines support `1h` and `30 phút`.
- Arrival timeline uses only `Type = A`; departure timeline uses only `Type = D`.
- The main flight list is not part of the new dashboard because Daily Schedule already handles flight-list operations.
- Timeline comparison uses average of matching weekdays in the same month, excluding the selected operational date.
- Default comparison metric is `Flights`.
- `Pax` remains selectable, but the UI must show pax coverage and missing-pax warnings.
- `Pax = 0` is expected for future planned flights. It becomes missing data only when a flight has passed by more than 1 day.
- `CTG (%) = dimension_diff / previous_period_total`.
- Both `weeknum` and `isoweek` must exist because reports use both depending on report type.
- `Note` values (`0`, `B`, `1`, `Cancelled`, `Delayed`) have no official business meaning and must not drive dashboard status.
- `Config2`, `Tàu nhỏ`, `Tàu to` use existing Settings `A/C Groups`; the dashboard should use group names such as `Big` and `Small` from settings.
- Alert thresholds are manually configured in Settings. If a threshold is empty, the corresponding alert is disabled.
- MVP persona is vận hành ca trực.

## Report Reference Contract

The report reference files in `docs/report_ref` show these repeated report groups:

- Sản lượng tổng hợp: day/month totals, ARR/DEP flights, ARR/DEP pax, average per day.
- Weekly comparison: airline/country/route by week, delta, delta percent, CTG.
- Market breakdown: airline, country, route by month or week.
- Operational peak analysis: hour and 30-minute slots, local/UTC, ARR/DEP split.
- Aircraft/config analysis: A/C type and configured small/big aircraft groups.
- Weekday pattern: month x weekday and same-weekday comparisons.

The new dashboard must preserve those data flows instead of creating generic charts.

---

## File Structure

- Create: `app/supabase/migrations/20260623090000_effective_dashboard_reporting.sql`
  - Adds effective reporting view and extends reporting allowlists.
- Modify: `app/supabase/schema.sql`
  - Mirrors the new reporting view/RPC contract for local schema reference.
- Create: `app/src/lib/operationalDashboardAnalysis.ts`
  - Pure analytics for operational KPI strip, ARR timeline, DEP timeline, same-weekday baseline, alerts, pax coverage.
- Create: `app/src/lib/operationalDashboardAnalysis.test.ts`
  - Unit tests for operational day, buckets, UTC labels, baseline, pax missing, alert thresholds.
- Modify: `app/src/lib/dashboardAnalysis.ts`
  - Keep CTG formula; add `weekBasis` for `weeknum` vs `isoweek`; remove assumptions tied to old overview UI.
- Create: `app/src/lib/dashboardReportingContract.source.test.ts`
  - Source tests for reporting contract and query-only AI boundary.
- Modify: `app/src/app/dashboard/page.tsx`
  - Replace dashboard tabs and widgets.
  - Remove old overview and old MoM/WoW UI sections.
  - Keep Fetch data and Sync controls.
  - Keep AI Workspace panel but remove dashboard-context coupling.
- Modify: `app/src/app/dashboard/components/AiWorkspacePanel.tsx`
  - Ensure labels/copy describe query-backed workspace only when relevant.
- Modify: `app/src/lib/dashboardAiAnalysis.ts`
  - Remove fallback paths that build analysis from dashboard records.
  - Update source contracts to effective reporting fields.
- Modify: `app/supabase/functions/dashboard-ai-analysis/index.ts`
  - Use allowlisted effective reporting fields for rows/aggregates.
  - Reject legacy dashboard data requests.
- Modify: `app/supabase/functions/_shared/dashboardAiShared.ts`
  - Align shared request/result contracts with direct reporting queries.
- Modify: `app/src/lib/settingsRules.ts`
  - Add dashboard alert settings defaults/validation and update AI source wording.
- Modify: `app/src/lib/types.ts`
  - Add dashboard alert settings types and operational dashboard analytics types if shared.
- Modify: `app/src/lib/supabaseRelationalMappers.ts`
  - Persist dashboard alert settings in `operational_settings`.
- Modify: `app/src/lib/supabaseStore.ts`
  - Read/write new settings fields.
- Create: `app/src/app/settings/components/DashboardAlertsTab.tsx`
  - Settings UI for alert thresholds.
- Modify: `app/src/app/settings/page.tsx`
  - Add `Dashboard Alerts` tab.
- Modify: `app/src/lib/dashboardReportExport.ts`
  - Add operational timeline and sản lượng comparison export templates.
- Modify: `context.md`
  - Update glossary/decision notes for operational date, effective reporting, CTG, pax missing, AI query-only boundary.

---

## Task 1: Lock The New Dashboard Contract With Source Tests

**Files:**
- Create: `app/src/lib/dashboardReportingContract.source.test.ts`
- Modify: `app/package.json`

- [ ] **Step 1: Add a source-regression test for tab replacement and AI decoupling**

Create `app/src/lib/dashboardReportingContract.source.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const dashboardPage = () => readFileSync(join(root, 'src/app/dashboard/page.tsx'), 'utf8');
const aiAnalysis = () => readFileSync(join(root, 'src/lib/dashboardAiAnalysis.ts'), 'utf8');
const aiFunction = () => readFileSync(join(root, 'supabase/functions/dashboard-ai-analysis/index.ts'), 'utf8');

test('dashboard replaces old overview and MoM/WoW tabs with operational views', () => {
  const source = dashboardPage();
  assert.match(source, /Vận hành ca trực/);
  assert.match(source, /So sánh sản lượng/);
  assert.match(source, /AI Workspace/);
  assert.doesNotMatch(source, />\s*Tổng quan\s*</);
  assert.doesNotMatch(source, />\s*Phân tích MoM \/ WoW\s*</);
});

test('AI Workspace does not receive dashboard context or selected dashboard rows', () => {
  const pageSource = dashboardPage();
  assert.doesNotMatch(pageSource, /buildDashboardAiContext\(/);
  assert.doesNotMatch(pageSource, /selectedDriverRecordsForAi/);
  assert.doesNotMatch(pageSource, /comparison-drivers/);
  assert.doesNotMatch(pageSource, /waterfallRows/);
});

test('AI Workspace source contracts require direct reporting queries', () => {
  const libSource = aiAnalysis();
  const edgeSource = aiFunction();
  assert.match(libSource, /query-only/i);
  assert.match(libSource, /reporting\.flight_operations/);
  assert.doesNotMatch(libSource, /SQL local độc lập/);
  assert.doesNotMatch(libSource, /local\/cache\/server/);
  assert.match(edgeSource, /dashboard_ai_query_rows/);
  assert.match(edgeSource, /dashboard_ai_query_aggregated/);
  assert.doesNotMatch(edgeSource, /legacy dataRequest/);
});

test('effective reporting migration exists and exposes operational fields', () => {
  const migrationPath = join(root, 'supabase/migrations/20260623090000_effective_dashboard_reporting.sql');
  assert.equal(existsSync(migrationPath), true);
  const source = readFileSync(migrationPath, 'utf8');
  assert.match(source, /reporting\.effective_flight_operations/);
  assert.match(source, /local_bucket_30/);
  assert.match(source, /local_bucket_60/);
  assert.match(source, /utc_bucket_30/);
  assert.match(source, /utc_bucket_60/);
  assert.match(source, /pax_missing_after_1_day/);
  assert.match(source, /weeknum/);
  assert.match(source, /isoweek/);
  assert.match(source, /ac_group/);
  assert.doesNotMatch(source, /\bnote\b/i);
});
```

- [ ] **Step 2: Add a package script for the contract test**

Modify `app/package.json` scripts:

```json
"test:dashboard-contract": "node --test src/lib/dashboardReportingContract.source.test.ts"
```

- [ ] **Step 3: Run the new test and confirm red**

Run:

```powershell
cd app
npm run test:dashboard-contract
```

Expected: FAIL because the migration and new tab labels are not implemented yet.

- [ ] **Step 4: Keep this test red until Tasks 2, 4, and 5 are complete**

Do not weaken assertions to pass early. This test protects the user-confirmed boundary.

---

## Task 2: Build Canonical Effective Supabase Reporting

**Files:**
- Create: `app/supabase/migrations/20260623090000_effective_dashboard_reporting.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Create the effective reporting migration**

Create `app/supabase/migrations/20260623090000_effective_dashboard_reporting.sql` with this structure:

```sql
create schema if not exists reporting;

create or replace view reporting.effective_flight_operations as
with base_records as (
  select
    r.season_id,
    r.record_id,
    r.link_id,
    r.type,
    r.airline,
    r.flight_number,
    r.raw_flight_number,
    r.route,
    r.schedule,
    r.aircraft,
    r.pax,
    r.gate,
    r.stand,
    r.carousel,
    r.date,
    r.scheduled_date,
    r.scheduled_time,
    r.operational_date,
    r.iata_season_code,
    r.flight_series_id,
    r.turnaround_id,
    r.source_kind,
    r.source_side,
    r.status,
    m.action as mod_action,
    m.changed_fields,
    m.schedule as mod_schedule,
    m.aircraft as mod_aircraft,
    m.route as mod_route,
    m.pax as mod_pax,
    m.gate as mod_gate,
    m.stand as mod_stand,
    m.carousel as mod_carousel
  from public.season_flight_records r
  left join public.season_modifications m
    on m.season_id = r.season_id
   and m.leg_id = r.record_id
  where r.status <> 'deleted'
    and coalesce(m.action, '') <> 'deleted'
),
effective_base as (
  select
    season_id,
    record_id,
    link_id,
    type,
    airline,
    flight_number,
    raw_flight_number,
    case when 'route' = any(coalesce(changed_fields, '{}')) then coalesce(mod_route, '') else route end as route,
    case when 'schedule' = any(coalesce(changed_fields, '{}')) then coalesce(mod_schedule, '') else schedule end as schedule,
    case when 'aircraft' = any(coalesce(changed_fields, '{}')) then coalesce(mod_aircraft, '') else aircraft end as aircraft,
    case when 'pax' = any(coalesce(changed_fields, '{}')) then mod_pax else pax end as pax,
    case when 'gate' = any(coalesce(changed_fields, '{}')) then mod_gate else gate end as gate,
    case when 'stand' = any(coalesce(changed_fields, '{}')) then mod_stand else stand end as stand,
    case when 'carousel' = any(coalesce(changed_fields, '{}')) then mod_carousel else carousel end as carousel,
    date,
    scheduled_date,
    scheduled_time,
    operational_date,
    iata_season_code,
    flight_series_id,
    turnaround_id,
    source_kind,
    source_side,
    case when mod_action = 'modified' then 'modified' else null end as effective_action,
    'base'::text as effective_source
  from base_records
),
effective_added as (
  select
    al.season_id,
    al.record_id,
    al.link_id,
    al.type,
    al.airline,
    al.flight_number,
    al.raw_flight_number,
    al.route,
    al.schedule,
    al.aircraft,
    al.pax,
    al.gate,
    al.stand,
    al.carousel,
    al.date,
    al.scheduled_date,
    al.scheduled_time,
    al.operational_date,
    al.iata_season_code,
    al.flight_series_id,
    al.turnaround_id,
    al.source_kind,
    al.source_side,
    'added'::text as effective_action,
    'added'::text as effective_source
  from public.season_modifications m
  join public.season_modification_added_legs al
    on al.season_id = m.season_id
   and al.leg_id = m.leg_id
  where m.action = 'added'
    and al.status <> 'deleted'
),
effective_records as (
  select * from effective_base
  union all
  select * from effective_added
),
time_enriched as (
  select
    e.*,
    case
      when e.schedule ~ '^[0-9]{1,2}:[0-9]{2}$'
      then split_part(e.schedule, ':', 1)::integer * 60 + split_part(e.schedule, ':', 2)::integer
      else null
    end as local_minutes
  from effective_records e
),
ops_enriched as (
  select
    t.*,
    case
      when nullif(t.operational_date, '') is not null then t.operational_date
      when t.local_minutes is not null and t.local_minutes < 300 then to_char(to_date(nullif(t.date, ''), 'YYYY-MM-DD') - interval '1 day', 'YYYY-MM-DD')
      else t.date
    end as computed_ops_date
  from time_enriched t
)
select
  o.season_id,
  coalesce(o.iata_season_code, s.season_code, '') as season,
  s.season_code,
  o.iata_season_code,
  o.record_id,
  o.flight_series_id,
  o.turnaround_id,
  o.type,
  o.flight_number as flight,
  o.airline,
  o.route,
  coalesce(rc.country, '') as country,
  o.aircraft,
  coalesce(ag.name, '') as ac_group,
  o.pax,
  o.date as scheduled_date,
  o.schedule as scheduled_time,
  o.computed_ops_date as ops_date,
  to_char(to_date(nullif(o.computed_ops_date, ''), 'YYYY-MM-DD'), 'YYYY-MM') as month,
  extract(week from to_date(nullif(o.computed_ops_date, ''), 'YYYY-MM-DD'))::integer as iso_week,
  to_char(to_date(nullif(o.computed_ops_date, ''), 'YYYY-MM-DD'), 'IYYY-"W"IW') as isoweek,
  to_char(to_date(nullif(o.computed_ops_date, ''), 'YYYY-MM-DD'), 'WW')::integer as weeknum,
  extract(dow from to_date(nullif(o.computed_ops_date, ''), 'YYYY-MM-DD'))::integer as weekday,
  o.local_minutes,
  case when o.local_minutes is null then null else floor(o.local_minutes / 30)::integer end as local_bucket_30_index,
  case when o.local_minutes is null then null else floor(o.local_minutes / 60)::integer end as local_bucket_60_index,
  case when o.local_minutes is null then null else lpad((floor(o.local_minutes / 30)::integer * 30 / 60)::text, 2, '0') || ':' || lpad(((floor(o.local_minutes / 30)::integer * 30) % 60)::text, 2, '0') end as local_bucket_30,
  case when o.local_minutes is null then null else lpad(floor(o.local_minutes / 60)::integer::text, 2, '0') || ':00' end as local_bucket_60,
  case when o.local_minutes is null then null else ((o.local_minutes - 420 + 1440) % 1440) end as utc_minutes,
  case when o.local_minutes is null then null else floor(((o.local_minutes - 420 + 1440) % 1440) / 30)::integer end as utc_bucket_30_index,
  case when o.local_minutes is null then null else floor(((o.local_minutes - 420 + 1440) % 1440) / 60)::integer end as utc_bucket_60_index,
  case when o.local_minutes is null then null else lpad((floor(((o.local_minutes - 420 + 1440) % 1440) / 30)::integer * 30 / 60)::text, 2, '0') || ':' || lpad(((floor(((o.local_minutes - 420 + 1440) % 1440) / 30)::integer * 30) % 60)::text, 2, '0') end as utc_bucket_30,
  case when o.local_minutes is null then null else lpad(floor(((o.local_minutes - 420 + 1440) % 1440) / 60)::integer::text, 2, '0') || ':00' end as utc_bucket_60,
  case
    when coalesce(o.pax, 0) <> 0 then false
    when o.local_minutes is null then false
    else (
      to_timestamp(o.date || ' ' || o.schedule, 'YYYY-MM-DD HH24:MI') <
      ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '1 day')
    )
  end as pax_missing_after_1_day,
  case
    when coalesce(o.pax, 0) = 0 then 'zero'
    else 'available'
  end as pax_status,
  'active'::text as status,
  o.gate,
  o.stand,
  o.carousel,
  o.source_kind,
  o.source_side,
  o.effective_action,
  o.effective_source
from ops_enriched o
left join public.seasons s on s.id = o.season_id
left join public.operational_route_countries rc on rc.route = o.route
left join public.operational_aircraft_group_types agt on upper(agt.aircraft_type) = upper(o.aircraft)
left join public.operational_aircraft_groups ag on ag.id = agt.group_id;

create or replace view reporting.flight_operations as
select * from reporting.effective_flight_operations;

alter view reporting.effective_flight_operations set (security_invoker = true);
alter view reporting.flight_operations set (security_invoker = true);
```

- [ ] **Step 2: Recreate summary views from `reporting.flight_operations`**

In the same migration, recreate the existing summary views so they use effective rows:

```sql
create or replace view reporting.summary_airline as
select season_id, season, airline, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, airline, type;

create or replace view reporting.summary_country as
select season_id, season, country, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, country, type;

create or replace view reporting.summary_route as
select season_id, season, route, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, route, type;

create or replace view reporting.summary_month as
select season_id, season, month, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, month, type;

create or replace view reporting.summary_week as
select season_id, season, isoweek, iso_week, weeknum, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, isoweek, iso_week, weeknum, type;

create or replace view reporting.summary_peak_hour as
select season_id, season, local_bucket_60, utc_bucket_60, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, local_bucket_60, utc_bucket_60, type;

create or replace view reporting.summary_aircraft as
select season_id, season, aircraft, ac_group, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, aircraft, ac_group, type;

create or replace view reporting.summary_arr_dep_mix as
select season_id, season, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, type;
```

- [ ] **Step 3: Extend row-query allowlist**

In `public.dashboard_ai_query_rows`, extend `allowed_columns`:

```sql
'weeknum',
'isoweek',
'local_minutes',
'utc_minutes',
'local_bucket_30',
'local_bucket_60',
'utc_bucket_30',
'utc_bucket_60',
'local_bucket_30_index',
'local_bucket_60_index',
'utc_bucket_30_index',
'utc_bucket_60_index',
'pax_status',
'pax_missing_after_1_day',
'ac_group',
'effective_action',
'effective_source'
```

Keep `allowed_views` as-is because `reporting.flight_operations` now resolves to effective rows. Add `effective_flight_operations` only if the AI UI explicitly needs to name it.

- [ ] **Step 4: Extend aggregate-query allowlist**

In `reporting.query_aggregated`, extend `allowed_group_by`:

```sql
'weeknum',
'isoweek',
'local_bucket_30',
'local_bucket_60',
'utc_bucket_30',
'utc_bucket_60',
'pax_status',
'pax_missing_after_1_day',
'ac_group'
```

Add optional filters:

```sql
if jsonb_typeof(p_filters->'weeknums') = 'array' then
  select string_agg(value::integer::text, ',')
    into value_list
  from jsonb_array_elements_text(p_filters->'weeknums') as value
  where value ~ '^[0-9]{1,2}$';
  if value_list is not null then
    where_clauses := where_clauses || format('weeknum in (%s)', value_list);
  end if;
end if;

if jsonb_typeof(p_filters->'isoweeks') = 'array' then
  select string_agg(quote_literal(value), ',')
    into value_list
  from jsonb_array_elements_text(p_filters->'isoweeks') as value
  where value ~ '^20[0-9]{2}-W[0-9]{2}$';
  if value_list is not null then
    where_clauses := where_clauses || format('isoweek in (%s)', value_list);
  end if;
end if;
```

- [ ] **Step 5: Mirror the migration into schema reference**

Modify `app/supabase/schema.sql` so local schema contains the same reporting view/RPC contract. Keep the old view name `reporting.flight_operations` but make it select from `reporting.effective_flight_operations`.

- [ ] **Step 6: Run the contract test**

Run:

```powershell
cd app
npm run test:dashboard-contract
```

Expected: still FAIL until dashboard page and AI decoupling are done, but the migration-specific assertion passes.

---

## Task 3: Add Operational Analytics Module

**Files:**
- Create: `app/src/lib/operationalDashboardAnalysis.ts`
- Create: `app/src/lib/operationalDashboardAnalysis.test.ts`
- Modify: `app/src/lib/dashboardAnalysis.ts`

- [ ] **Step 1: Write failing analytics tests**

Create `app/src/lib/operationalDashboardAnalysis.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlightRecord, OperationalSettings } from './types';
import {
  buildOperationalDashboard,
  buildOperationalTimeline,
  computePaxCoverage,
} from './operationalDashboardAnalysis';

function record(overrides: Partial<FlightRecord> & Pick<FlightRecord, 'id' | 'type' | 'date' | 'schedule'>): FlightRecord {
  return {
    id: overrides.id,
    linkId: overrides.linkId ?? overrides.id,
    type: overrides.type,
    airline: overrides.airline ?? 'VN',
    flightNumber: overrides.flightNumber ?? '123',
    rawFlightNumber: overrides.rawFlightNumber ?? overrides.flightNumber ?? 'VN123',
    requestStatusCode: null,
    route: overrides.route ?? 'CXRHAN',
    schedule: overrides.schedule,
    aircraft: overrides.aircraft ?? '321',
    category: '',
    flightType: '',
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
    scheduledDate: overrides.scheduledDate,
    scheduledTime: overrides.scheduledTime,
    operationalDate: overrides.operationalDate,
    iataSeasonCode: 'S26',
    dayOfWeek: 1,
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'imported',
    sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
    status: 'active',
    ...overrides,
  };
}

const settings = {
  aircraftGroups: [
    { id: 'big', name: 'Big', aircraftTypes: ['330', '789'], createdAt: 1, updatedAt: 1 },
    { id: 'small', name: 'Small', aircraftTypes: ['320', '321'], createdAt: 1, updatedAt: 1 },
  ],
  dashboardAlerts: {
    arrivalBucketFlights: 2,
    departureBucketFlights: 2,
    adGapFlights: 2,
    ctgAbsPct: 0.2,
    paxCoverageMinPct: 0.9,
  },
} as OperationalSettings;

test('timeline uses operational day 05:00 to 04:59 and separates ARR/DEP', () => {
  const rows = [
    record({ id: 'a1', type: 'A', date: '2026-04-02', schedule: '04:30' }),
    record({ id: 'a2', type: 'A', date: '2026-04-02', schedule: '05:00' }),
    record({ id: 'd1', type: 'D', date: '2026-04-02', schedule: '06:00' }),
  ];
  const arr = buildOperationalTimeline(rows, {
    operationalDate: '2026-04-01',
    type: 'A',
    bucketSizeMinutes: 30,
    timeBasis: 'local',
  });
  assert.equal(arr.buckets.find((bucket) => bucket.label === '04:30 +1')?.flights, 1);
  assert.equal(arr.buckets.find((bucket) => bucket.label === '05:00')?.flights, 0);

  const dep = buildOperationalTimeline(rows, {
    operationalDate: '2026-04-02',
    type: 'D',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });
  assert.equal(dep.buckets.find((bucket) => bucket.label === '06:00')?.flights, 1);
});

test('UTC toggle keeps the same operational window and shifts labels only', () => {
  const rows = [record({ id: 'a1', type: 'A', date: '2026-04-02', schedule: '05:00' })];
  const local = buildOperationalTimeline(rows, {
    operationalDate: '2026-04-02',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });
  const utc = buildOperationalTimeline(rows, {
    operationalDate: '2026-04-02',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'utc',
  });
  assert.equal(local.buckets.find((bucket) => bucket.label === '05:00')?.flights, 1);
  assert.equal(utc.buckets.find((bucket) => bucket.label === '22:00 -1')?.flights, 1);
});

test('baseline averages matching weekdays in the same month and excludes selected date', () => {
  const rows = [
    record({ id: 'selected', type: 'A', date: '2026-04-06', schedule: '08:00' }),
    record({ id: 'mon1', type: 'A', date: '2026-04-13', schedule: '08:00' }),
    record({ id: 'mon2', type: 'A', date: '2026-04-20', schedule: '08:00' }),
    record({ id: 'tue', type: 'A', date: '2026-04-07', schedule: '08:00' }),
  ];
  const result = buildOperationalDashboard({
    records: rows,
    operationalDate: '2026-04-06',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    settings,
    nowLocal: new Date('2026-04-06T12:00:00+07:00'),
  });
  const bucket = result.arrivals.buckets.find((item) => item.label === '08:00');
  assert.equal(bucket?.flights, 1);
  assert.equal(bucket?.baselineAvgFlights, 1);
});

test('pax zero is missing only after one day has passed', () => {
  const rows = [
    record({ id: 'past', type: 'A', date: '2026-04-01', schedule: '08:00', pax: 0 }),
    record({ id: 'future', type: 'A', date: '2026-04-04', schedule: '08:00', pax: 0 }),
    record({ id: 'available', type: 'A', date: '2026-04-01', schedule: '09:00', pax: 120 }),
  ];
  const coverage = computePaxCoverage(rows, new Date('2026-04-03T09:01:00+07:00'));
  assert.equal(coverage.missingAfterOneDay, 1);
  assert.equal(coverage.plannedZero, 1);
  assert.equal(coverage.available, 1);
});
```

- [ ] **Step 2: Run the analytics tests and confirm red**

Run:

```powershell
cd app
node --experimental-strip-types --test src/lib/operationalDashboardAnalysis.test.ts
```

Expected: FAIL because `operationalDashboardAnalysis.ts` does not exist.

- [ ] **Step 3: Create operational analytics types and helpers**

Create `app/src/lib/operationalDashboardAnalysis.ts`:

```ts
import type { FlightRecord, OperationalSettings } from './types';
import type { DashboardTimeBasis } from './dashboardAnalysis';
import { getDashboardOperationalDate } from './dashboardAnalysis';

export type OperationalBucketSizeMinutes = 30 | 60;
export type OperationalTimelineType = 'A' | 'D';

export interface OperationalTimelineInput {
  records: FlightRecord[];
  operationalDate: string;
  type: OperationalTimelineType;
  bucketSizeMinutes: OperationalBucketSizeMinutes;
  timeBasis: DashboardTimeBasis;
}

export interface OperationalTimelineBucket {
  index: number;
  localLabel: string;
  utcLabel: string;
  label: string;
  flights: number;
  pax: number;
  baselineAvgFlights: number;
  deltaVsBaseline: number;
  records: FlightRecord[];
}

export interface OperationalTimelineResult {
  type: OperationalTimelineType;
  bucketSizeMinutes: OperationalBucketSizeMinutes;
  timeBasis: DashboardTimeBasis;
  buckets: OperationalTimelineBucket[];
  peakBucket: OperationalTimelineBucket | null;
}

export interface OperationalPaxCoverage {
  total: number;
  available: number;
  plannedZero: number;
  missingAfterOneDay: number;
  coveragePct: number;
}

export interface OperationalAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  dimension: 'arrival-timeline' | 'departure-timeline' | 'pax' | 'ad-gap' | 'ctg';
}

export interface OperationalDashboardInput {
  records: FlightRecord[];
  operationalDate: string;
  bucketSizeMinutes: OperationalBucketSizeMinutes;
  timeBasis: DashboardTimeBasis;
  settings: OperationalSettings;
  nowLocal: Date;
}

export interface OperationalDashboardResult {
  operationalDate: string;
  arrivals: OperationalTimelineResult;
  departures: OperationalTimelineResult;
  paxCoverage: OperationalPaxCoverage;
  alerts: OperationalAlert[];
  kpis: {
    arrivals: number;
    departures: number;
    totalFlights: number;
    adGap: number;
    peakArrivalBucket: string;
    peakDepartureBucket: string;
  };
}
```

Then implement:

```ts
const LOCAL_UTC_OFFSET_MINUTES = 7 * 60;
const MINUTES_PER_DAY = 24 * 60;
const OPERATIONAL_START_MINUTES = 5 * 60;

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatMinutes(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function labelWithDayOffset(minutesFromLocalWindowStart: number, labelMinutes: number): string {
  const dayOffset = Math.floor((OPERATIONAL_START_MINUTES + minutesFromLocalWindowStart) / MINUTES_PER_DAY);
  const suffix = dayOffset > 0 ? ` +${dayOffset}` : dayOffset < 0 ? ` ${dayOffset}` : '';
  return `${formatMinutes(labelMinutes)}${suffix}`;
}
```

- [ ] **Step 4: Implement timeline and baseline**

Add:

```ts
export function buildOperationalTimeline(input: OperationalTimelineInput): OperationalTimelineResult {
  const bucketCount = MINUTES_PER_DAY / input.bucketSizeMinutes;
  const buckets = Array.from({ length: bucketCount }, (_, index): OperationalTimelineBucket => {
    const localMinutesFromStart = index * input.bucketSizeMinutes;
    const localMinutes = (OPERATIONAL_START_MINUTES + localMinutesFromStart) % MINUTES_PER_DAY;
    const utcMinutes = (localMinutes - LOCAL_UTC_OFFSET_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return {
      index,
      localLabel: labelWithDayOffset(localMinutesFromStart, localMinutes),
      utcLabel: labelWithDayOffset(localMinutesFromStart - LOCAL_UTC_OFFSET_MINUTES, utcMinutes),
      label: input.timeBasis === 'utc'
        ? labelWithDayOffset(localMinutesFromStart - LOCAL_UTC_OFFSET_MINUTES, utcMinutes)
        : labelWithDayOffset(localMinutesFromStart, localMinutes),
      flights: 0,
      pax: 0,
      baselineAvgFlights: 0,
      deltaVsBaseline: 0,
      records: [],
    };
  });

  for (const record of input.records) {
    if (record.status === 'deleted' || record.type !== input.type) continue;
    if (getDashboardOperationalDate(record) !== input.operationalDate) continue;
    const minutes = parseMinutes(record.schedule);
    if (minutes == null) continue;
    const elapsed = (minutes - OPERATIONAL_START_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const index = Math.floor(elapsed / input.bucketSizeMinutes);
    const bucket = buckets[index];
    bucket.flights += 1;
    bucket.pax += Number.isFinite(record.pax) ? Number(record.pax) : 0;
    bucket.records.push(record);
  }

  const peakBucket = buckets.reduce<OperationalTimelineBucket | null>(
    (best, bucket) => (!best || bucket.flights > best.flights ? bucket : best),
    null
  );
  return { type: input.type, bucketSizeMinutes: input.bucketSizeMinutes, timeBasis: input.timeBasis, buckets, peakBucket };
}
```

Add baseline calculation in `buildOperationalDashboard()` by:

- Find selected operational weekday and month.
- Build same timeline for each matching operational date in the same month.
- Exclude the selected operational date.
- Average each bucket across matching dates.
- Set `baselineAvgFlights` and `deltaVsBaseline` on arrival and departure timelines.

- [ ] **Step 5: Implement pax coverage and alerts**

Add:

```ts
export function computePaxCoverage(records: FlightRecord[], nowLocal: Date): OperationalPaxCoverage {
  let available = 0;
  let plannedZero = 0;
  let missingAfterOneDay = 0;
  for (const record of records) {
    const pax = Number.isFinite(record.pax) ? Number(record.pax) : 0;
    if (pax > 0) {
      available += 1;
      continue;
    }
    const scheduledAt = new Date(`${record.date}T${record.schedule}:00+07:00`);
    const missing = Number.isFinite(scheduledAt.getTime()) &&
      scheduledAt.getTime() + 24 * 60 * 60 * 1000 < nowLocal.getTime();
    if (missing) missingAfterOneDay += 1;
    else plannedZero += 1;
  }
  const total = records.length;
  return {
    total,
    available,
    plannedZero,
    missingAfterOneDay,
    coveragePct: total === 0 ? 1 : available / total,
  };
}
```

Generate alerts only when Settings thresholds are present:

```ts
function buildOperationalAlerts(input: {
  arrivals: OperationalTimelineResult;
  departures: OperationalTimelineResult;
  paxCoverage: OperationalPaxCoverage;
  settings: OperationalSettings;
}): OperationalAlert[] {
  const thresholds = input.settings.dashboardAlerts;
  const alerts: OperationalAlert[] = [];
  if (thresholds.arrivalBucketFlights != null) {
    for (const bucket of input.arrivals.buckets.filter((item) => item.flights >= thresholds.arrivalBucketFlights!)) {
      alerts.push({
        id: `arrival-${bucket.index}`,
        severity: 'warning',
        title: `ARR peak ${bucket.label}`,
        message: `${bucket.flights} chuyến đến trong bucket ${bucket.label}.`,
        dimension: 'arrival-timeline',
      });
    }
  }
  if (thresholds.departureBucketFlights != null) {
    for (const bucket of input.departures.buckets.filter((item) => item.flights >= thresholds.departureBucketFlights!)) {
      alerts.push({
        id: `departure-${bucket.index}`,
        severity: 'warning',
        title: `DEP peak ${bucket.label}`,
        message: `${bucket.flights} chuyến đi trong bucket ${bucket.label}.`,
        dimension: 'departure-timeline',
      });
    }
  }
  if (thresholds.paxCoverageMinPct != null && input.paxCoverage.coveragePct < thresholds.paxCoverageMinPct) {
    alerts.push({
      id: 'pax-coverage',
      severity: 'critical',
      title: 'Pax coverage thấp',
      message: `${input.paxCoverage.missingAfterOneDay} chuyến đã qua hơn 1 ngày vẫn Pax = 0.`,
      dimension: 'pax',
    });
  }
  return alerts;
}
```

- [ ] **Step 6: Add week basis to existing comparison**

Modify `app/src/lib/dashboardAnalysis.ts`:

```ts
export type DashboardWeekBasis = 'weeknum' | 'isoweek';

export interface DashboardComparisonInput {
  records: FlightRecord[];
  routeCountries?: RouteCountryMapping[];
  mode: DashboardComparisonMode;
  granularity?: DashboardComparisonGranularity;
  weekBasis?: DashboardWeekBasis;
  metric: DashboardMetric;
  currentPeriod: string;
  previousPeriod: string;
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  dimension: DashboardDimension;
}
```

Update `periodKey()` so WoW can use either:

```ts
function weeknumKey(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return '';
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const day = Math.floor((parsed.getTime() - start.getTime()) / 86400000) + 1;
  return `${parsed.getUTCFullYear()}-W${String(Math.ceil(day / 7)).padStart(2, '0')}`;
}

function periodKey(
  record: FlightRecord,
  mode: DashboardComparisonMode,
  granularity: DashboardComparisonGranularity = 'month',
  weekBasis: DashboardWeekBasis = 'isoweek'
): string {
  const operationalDate = getDashboardOperationalDate(record);
  if (mode === 'wow') return weekBasis === 'weeknum' ? weeknumKey(operationalDate) : isoWeekKey(operationalDate);
  if (mode === 'yoy' && granularity === 'year') return operationalDate.slice(0, 4);
  return monthKey(operationalDate);
}
```

Keep this CTG line unchanged:

```ts
ctgPct: safeRatio(delta, previousTotal),
```

- [ ] **Step 7: Run analytics tests**

Run:

```powershell
cd app
node --experimental-strip-types --test src/lib/operationalDashboardAnalysis.test.ts
```

Expected: PASS.

---

## Task 4: Add Dashboard Alert Settings

**Files:**
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/settingsRules.ts`
- Modify: `app/src/lib/supabaseRelationalMappers.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/supabase/migrations/20260623090000_effective_dashboard_reporting.sql`
- Modify: `app/supabase/schema.sql`
- Create: `app/src/app/settings/components/DashboardAlertsTab.tsx`
- Modify: `app/src/app/settings/page.tsx`

- [ ] **Step 1: Add dashboard alert settings type**

In `app/src/lib/types.ts`:

```ts
export interface DashboardAlertSettings {
  arrivalBucketFlights: number | null;
  departureBucketFlights: number | null;
  adGapFlights: number | null;
  ctgAbsPct: number | null;
  paxCoverageMinPct: number | null;
}

export interface OperationalSettings {
  airlineColors: AirlineColorSetting[];
  routeCountries: RouteCountryMapping[];
  aiAnalysis: AiAnalysisSettings;
  dashboardAlerts: DashboardAlertSettings;
  aircraftGroups: AircraftGroup[];
  counterAllocationRules: CounterAllocationRule[];
  checkInCounters: CheckInCounterResource[];
  checkInCounterGroups: CheckInCounterGroup[];
  checkInCounterLocks: CheckInCounterLock[];
  gateResources: GateResource[];
  gateGroups: GateGroup[];
  gateLocks: GateLock[];
  standGateMappings: StandGateMapping[];
  updatedAt: number | null;
}
```

- [ ] **Step 2: Add defaults and validation**

In `app/src/lib/settingsRules.ts`:

```ts
export const DEFAULT_DASHBOARD_ALERT_SETTINGS: DashboardAlertSettings = {
  arrivalBucketFlights: null,
  departureBucketFlights: null,
  adGapFlights: null,
  ctgAbsPct: null,
  paxCoverageMinPct: null,
};

function normalizeNullableNumber(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDashboardAlerts(input: Partial<DashboardAlertSettings> | undefined): DashboardAlertSettings {
  return {
    arrivalBucketFlights: normalizeNullableNumber(input?.arrivalBucketFlights, 1, 999),
    departureBucketFlights: normalizeNullableNumber(input?.departureBucketFlights, 1, 999),
    adGapFlights: normalizeNullableNumber(input?.adGapFlights, 1, 999),
    ctgAbsPct: normalizeNullableNumber(input?.ctgAbsPct, 0, 10),
    paxCoverageMinPct: normalizeNullableNumber(input?.paxCoverageMinPct, 0, 1),
  };
}
```

Call it from `hydrateOperationalSettings()` and `validateOperationalSettings()`:

```ts
dashboardAlerts: normalizeDashboardAlerts(settings?.dashboardAlerts),
```

- [ ] **Step 3: Persist settings in Supabase**

Add nullable columns to the migration and `schema.sql`:

```sql
alter table public.operational_settings
  add column if not exists dashboard_arrival_bucket_flights integer,
  add column if not exists dashboard_departure_bucket_flights integer,
  add column if not exists dashboard_ad_gap_flights integer,
  add column if not exists dashboard_ctg_abs_pct numeric,
  add column if not exists dashboard_pax_coverage_min_pct numeric;
```

Extend `OperationalSettingsRow` in `app/src/lib/supabaseRelationalMappers.ts`:

```ts
dashboard_arrival_bucket_flights: number | null;
dashboard_departure_bucket_flights: number | null;
dashboard_ad_gap_flights: number | null;
dashboard_ctg_abs_pct: number | null;
dashboard_pax_coverage_min_pct: number | null;
```

Map to row:

```ts
dashboard_arrival_bucket_flights: normalized.dashboardAlerts.arrivalBucketFlights,
dashboard_departure_bucket_flights: normalized.dashboardAlerts.departureBucketFlights,
dashboard_ad_gap_flights: normalized.dashboardAlerts.adGapFlights,
dashboard_ctg_abs_pct: normalized.dashboardAlerts.ctgAbsPct,
dashboard_pax_coverage_min_pct: normalized.dashboardAlerts.paxCoverageMinPct,
```

Map from row:

```ts
dashboardAlerts: {
  arrivalBucketFlights: input.settingsRow?.dashboard_arrival_bucket_flights ?? null,
  departureBucketFlights: input.settingsRow?.dashboard_departure_bucket_flights ?? null,
  adGapFlights: input.settingsRow?.dashboard_ad_gap_flights ?? null,
  ctgAbsPct: input.settingsRow?.dashboard_ctg_abs_pct ?? null,
  paxCoverageMinPct: input.settingsRow?.dashboard_pax_coverage_min_pct ?? null,
},
```

- [ ] **Step 4: Create Settings UI**

Create `app/src/app/settings/components/DashboardAlertsTab.tsx`:

```tsx
'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { OperationalSettings } from '@/lib/types';

type Props = {
  settings: OperationalSettings;
  setSettings: Dispatch<SetStateAction<OperationalSettings>>;
};

const fields = [
  ['arrivalBucketFlights', 'ARR bucket threshold', 'Chuyến đến mỗi bucket'],
  ['departureBucketFlights', 'DEP bucket threshold', 'Chuyến đi mỗi bucket'],
  ['adGapFlights', 'A-D gap threshold', 'Chênh lệch đến/đi'],
  ['ctgAbsPct', 'CTG threshold', 'Ví dụ 0.2 = 20%'],
  ['paxCoverageMinPct', 'Pax coverage minimum', 'Ví dụ 0.9 = 90%'],
] as const;

export default function DashboardAlertsTab({ settings, setSettings }: Props) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      {fields.map(([key, label, hint]) => (
        <label key={key} className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 text-sm font-semibold text-on-surface">
          {label}
          <input
            type="number"
            step={key.includes('Pct') ? '0.01' : '1'}
            value={settings.dashboardAlerts[key] ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              setSettings((current) => ({
                ...current,
                dashboardAlerts: {
                  ...current.dashboardAlerts,
                  [key]: raw === '' ? null : Number(raw),
                },
                updatedAt: Date.now(),
              }));
            }}
            className="mt-2 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
          <span className="mt-1 block text-xs font-normal text-on-surface-variant">{hint}</span>
        </label>
      ))}
    </section>
  );
}
```

- [ ] **Step 5: Add tab to settings page**

In `app/src/app/settings/page.tsx`, import the component:

```tsx
import DashboardAlertsTab from './components/DashboardAlertsTab';
```

Add tab:

```tsx
{ id: 'dashboardAlerts' as const, label: 'Dashboard Alerts' },
```

Render:

```tsx
{activeTab === 'dashboardAlerts' && (
  <DashboardAlertsTab settings={settings} setSettings={setSettings} />
)}
```

- [ ] **Step 6: Run settings validation checks**

Run:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
```

Expected: `rule regression tests passed` and TypeScript exit code `0`.

---

## Task 5: Replace Dashboard UI Views

**Files:**
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/lib/dashboardReportExport.ts`

- [ ] **Step 1: Rename dashboard view state**

In `app/src/app/dashboard/page.tsx`, replace:

```ts
type DashboardView = 'overview' | 'analysis' | 'ai-workspace';
```

with:

```ts
type DashboardView = 'operations' | 'comparison' | 'ai-workspace';
```

Update session default:

```ts
const [dashboardView, setDashboardView] = useSessionState<DashboardView>('dashboard:view', 'operations');
```

Map older stored values once:

```ts
useEffect(() => {
  if (dashboardView === 'overview') setDashboardView('operations');
  if (dashboardView === 'analysis') setDashboardView('comparison');
}, [dashboardView, setDashboardView]);
```

- [ ] **Step 2: Replace tab labels**

Replace the tab group with:

```tsx
<div className="mt-1 grid grid-cols-3 rounded-lg border border-outline-variant bg-surface p-1">
  <button type="button" onClick={() => setDashboardView('operations')} className={tabClass(dashboardView === 'operations')}>
    <span className="material-symbols-outlined text-[18px]">monitoring</span>
    Vận hành ca trực
  </button>
  <button type="button" onClick={() => setDashboardView('ai-workspace')} className={tabClass(dashboardView === 'ai-workspace')}>
    <span className="material-symbols-outlined text-[18px]">dashboard_customize</span>
    AI Workspace
  </button>
  <button type="button" onClick={() => setDashboardView('comparison')} className={tabClass(dashboardView === 'comparison')}>
    <span className="material-symbols-outlined text-[18px]">analytics</span>
    So sánh sản lượng
  </button>
</div>
```

Keep visual density restrained: compact filters, KPI strip, timelines, tables; no hero or decorative sections.

- [ ] **Step 3: Add operational state**

Add state:

```ts
const [operationalDate, setOperationalDate] = useSessionState('dashboard:operationalDate', '');
const [bucketSizeMinutes, setBucketSizeMinutes] = useSessionState<30 | 60>('dashboard:bucketSizeMinutes', 60);
const [timelineTimeBasis, setTimelineTimeBasis] = useSessionState<DashboardTimeBasis>('dashboard:timelineTimeBasis', 'local');
```

Default `operationalDate` to today in local time if present in season range:

```ts
const activeOperationalDate = operationalDate || latestOperationalDateFromRecords(dashboardRecords) || '';
```

- [ ] **Step 4: Build operational dashboard data**

Import:

```ts
import { buildOperationalDashboard } from '@/lib/operationalDashboardAnalysis';
```

Build:

```ts
const operationalDashboard = useMemo(() => (
  activeOperationalDate && operationalSettings
    ? buildOperationalDashboard({
        records: dashboardRecords,
        operationalDate: activeOperationalDate,
        bucketSizeMinutes,
        timeBasis: timelineTimeBasis,
        settings: operationalSettings,
        nowLocal: new Date(),
      })
    : null
), [activeOperationalDate, bucketSizeMinutes, dashboardRecords, operationalSettings, timelineTimeBasis]);
```

- [ ] **Step 5: Render `Vận hành ca trực` widgets**

Replace the old `dashboardView === 'overview'` branch with these sections:

1. **Operational filters**

```tsx
<section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
  <div className="grid gap-3 md:grid-cols-4">
    <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
      Operational date
      <input type="date" value={activeOperationalDate} onChange={(event) => setOperationalDate(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
    </label>
    <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
      Bucket
      <select value={bucketSizeMinutes} onChange={(event) => setBucketSizeMinutes(Number(event.target.value) as 30 | 60)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm">
        <option value={60}>1h</option>
        <option value={30}>30 phút</option>
      </select>
    </label>
    <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
      Time basis
      <select value={timelineTimeBasis} onChange={(event) => setTimelineTimeBasis(event.target.value as DashboardTimeBasis)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm">
        <option value="local">Local STA/STD</option>
        <option value="utc">UTC</option>
      </select>
    </label>
    <div className="rounded-md bg-surface-container-low px-3 py-2 text-xs font-semibold text-on-surface-variant">
      Window
      <div className="mt-1 text-sm font-bold text-on-surface">05:00 -> 04:59 +1</div>
    </div>
  </div>
</section>
```

2. **KPI strip**

Show:

- `ARR flights`
- `DEP flights`
- `Total flights`
- `A-D gap`
- `Peak ARR bucket`
- `Peak DEP bucket`
- `Pax coverage`
- `Pax missing > 1 ngày`

3. **Timeline vận hành - chuyến đến**

Use `operationalDashboard.arrivals.buckets`. Required columns/visual marks:

- Bucket label.
- Flights bar.
- Same-weekday baseline line/marker.
- Delta vs baseline.
- Pax sum as secondary text.
- Click bucket filters drill-down detail cards by airline/route within that bucket.

4. **Timeline vận hành - chuyến đi**

Use `operationalDashboard.departures.buckets` with the same structure. This replaces the old main flight list.

5. **Xu hướng chuyến bay theo ngày**

Add a compact daily trend chart for the selected wide range, not only the selected operational date:

- X-axis: operational date.
- Y-axis: total flights, with ARR/DEP stacked or split.
- Default range: current month of selected operational date.
- Interaction: click a day to set `operationalDate` and refresh the ARR/DEP timelines above.
- Tooltip: operational date, ARR, DEP, total flights, pax, same-weekday monthly average, delta vs baseline.
- Highlight: selected operational date, max day, days with alert thresholds exceeded.

6. **Peak Day Heatmap**

Add a wide-range scan heatmap for day-level peaks:

- Primary display: calendar heatmap by operational date.
- Cell value: total flights.
- Cell split marker: ARR/DEP ratio.
- Cell badges: pax missing after 1 day, A-D gap threshold, peak hour threshold.
- Alternate display: month x weekday heatmap, with value `avg flights/day` or `total flights`.
- Interaction: click day or weekday cell to update selected operational date or drill into matching dates.

7. **Peak Hour Heatmap**

Add a wide-range scan heatmap for hour/bucket-level peaks:

- Y-axis: operational date.
- X-axis: operational time bucket from `05:00` to `04:59 +1`.
- Cell value modes: `ARR`, `DEP`, `ARR+DEP`, `A-D gap`, `vs baseline`.
- Bucket toggle: `1h` / `30 phút`.
- Time basis toggle: `Local STA/STD` / `UTC`.
- Tooltip: operational date, bucket, ARR, DEP, total, pax, same-weekday baseline average, delta.
- Interaction: click cell to select date + bucket and update drill-down cards.

8. **Exception/Alert panel**

Use `operationalDashboard.alerts`, sorted critical before warning before info. Empty state text: `Không có cảnh báo theo ngưỡng hiện tại.`

9. **Drill-down panel**

On bucket click, show compact aggregated tables, not flight list:

- Airline ranking in selected bucket.
- Route ranking in selected bucket.
- A/C group split in selected bucket.
- Link button to Daily Schedule for the operational date.

- [ ] **Step 6: Render `So sánh sản lượng` widgets**

Replace the old `dashboardView === 'analysis'` branch with:

1. **Comparison filters**

- Mode: `WoW`, `MoM`, `YoY` if existing multi-season data is present.
- Week basis visible only for WoW: `isoweek` / `weeknum`.
- Metric: `Flights` default; `Pax` selectable.
- Type filter: `All`, `ARR`, `DEP`.
- Dimension: `Airline`, `Country`, `Route`, `A/C Group`, `A/C Type`, `Weekday`, `Hour`.
- Current period and previous period.

2. **Pax coverage warning**

When `metric === 'pax'`, show coverage for current and previous periods. If coverage is below `settings.dashboardAlerts.paxCoverageMinPct` or missing data exists, render a warning before charts.

3. **KPI strip**

- Current total.
- Previous total.
- Difference.
- Difference percent.
- Top gain.
- Top drag.
- Top CTG.

4. **CTG ranking table**

Required columns:

- Dimension.
- Current.
- Previous.
- Difference.
- Difference percent.
- CTG.
- Current share.
- Previous share.
- Share shift.

Keep the CTG formula from `dashboardAnalysis.ts`: `delta / previousTotal`.

5. **Xu hướng chuyến bay theo tháng**

Show monthly trend for the selected season/range:

- X-axis: month.
- Y-axis: flights.
- ARR/DEP: stacked bars or split bars.
- Metric default: `Flights`; allow `Pax` with pax coverage warning.
- Interaction: click month to set comparison mode `MoM` and select current/previous month.
- Tooltip: ARR, DEP, total flights, pax, average flights/day, pax coverage.
- Use case: reproduce the report flow from `TOTAL`, monthly sheets, and S26 `Month` sheet.

6. **Xu hướng chuyến bay theo ngày**

Show daily trend inside the selected month or comparison period:

- X-axis: operational date.
- Y-axis: flights.
- ARR/DEP: stacked bars.
- Highlight: peak day, selected comparison dates, days with alert thresholds exceeded.
- Interaction: click day to open period drill-down and optionally route to Daily Schedule.
- Use case: identify which specific dates explain MoM/WoW movement before drilling into dimension drivers.

7. **Trend panel by selected dimension**

Show period trend for selected dimension and metric:

- WoW: weeks.
- MoM: months.
- YoY: year or same month across seasons if data exists.

8. **Comparison drill-down**

On dimension row click, show aggregated drill-down:

- Daily distribution for the selected dimension.
- Airline/route/country sub-breakdown where applicable.
- Button to open Daily Schedule for selected period/date.

Do not restore the old selected-driver flight list as the primary content.

- [ ] **Step 7: Update exports**

In `app/src/lib/dashboardReportExport.ts`, extend:

```ts
export type DashboardReportTemplateId =
  | 'operational-timeline'
  | 'sanluong-comparison'
  | 'sanluong-summary'
  | 'mom-wow-analysis';
```

Add workbook sheets:

- `Operational KPIs`
- `ARR Timeline`
- `DEP Timeline`
- `Alerts`
- `Comparison KPIs`
- `CTG Ranking`
- `Drilldown`

Keep old template ids working as aliases:

```ts
if (templateId === 'mom-wow-analysis') return buildSanluongComparisonWorkbook(input);
if (templateId === 'sanluong-summary') return buildOperationalTimelineWorkbook(input);
```

- [ ] **Step 8: Run dashboard contract and typecheck**

Run:

```powershell
cd app
npm run test:dashboard-contract
npx tsc --noEmit --pretty false
```

Expected: contract test still may fail on AI decoupling until Task 6; TypeScript passes for dashboard UI changes.

---

## Task 6: Decouple AI Workspace From Dashboard Context

**Files:**
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/lib/dashboardAiAnalysis.ts`
- Modify: `app/supabase/functions/dashboard-ai-analysis/index.ts`
- Modify: `app/supabase/functions/_shared/dashboardAiShared.ts`
- Modify: `app/src/lib/settingsRules.ts`

- [ ] **Step 1: Remove dashboard-record payload from AI requests**

In `app/src/app/dashboard/page.tsx`, remove request construction that passes:

- `buildDashboardAiContext(...)`
- `comparison`
- `waterfallRows`
- `selectedDriverRecordsForAi`
- `dashboardRecords`
- `effectiveRecords`
- `resolvedDataRequest` built from dashboard rows

Replace the request context with season metadata only:

```ts
const aiRequestContext = {
  sourcePolicy: 'supabase-reporting-query-only',
  seasons: selectedAiSeasonIds
    .map((seasonId) => seasons.find((item) => item.id === seasonId))
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      seasonCode: item.seasonCode,
      effectiveStart: item.effectiveStart,
      effectiveEnd: item.effectiveEnd,
    })),
};
```

- [ ] **Step 2: Remove native/local AI data loading path from dashboard page**

Delete or stop using:

```ts
loadAiWorkspaceSeason
aiWorkspaceSeasonData
analysisSeasonData
selectedDriverRecordsForAi
queryNativeDashboardAiSql
queryNativeScheduleWindow
```

Keep only season selector state and notebook state.

- [ ] **Step 3: Update AI contracts**

In `app/src/lib/dashboardAiAnalysis.ts`, update prepared data/source wording:

```ts
sourceDescription: 'Nguồn: Supabase reporting.flight_operations effective view qua RPC allowlist.',
```

Remove fallback copy that says:

- `SQL local độc lập`
- `local/cache/server`
- `dashboard-data-request`
- `request_dashboard_data_slice`
- `MoM/WoW payload`

Make the fallback answer explicit:

```ts
return {
  answer: 'AI Workspace cần truy vấn Supabase reporting để phân tích dữ liệu. Không dùng context từ dashboard hiện tại.',
  queryPlans: suggestedQueryPlans,
};
```

- [ ] **Step 4: Extend Edge Function allowed fields**

In `app/supabase/functions/dashboard-ai-analysis/index.ts`, update tool descriptions and field allowlist to include:

```ts
const REPORTING_FIELDS = [
  'season_id',
  'season',
  'season_code',
  'iata_season_code',
  'record_id',
  'type',
  'flight',
  'airline',
  'route',
  'country',
  'aircraft',
  'ac_group',
  'pax',
  'scheduled_date',
  'scheduled_time',
  'ops_date',
  'month',
  'iso_week',
  'isoweek',
  'weeknum',
  'weekday',
  'local_bucket_30',
  'local_bucket_60',
  'utc_bucket_30',
  'utc_bucket_60',
  'pax_status',
  'pax_missing_after_1_day',
  'effective_action',
  'effective_source',
] as const;
```

Reject legacy data requests:

```ts
if (response.dataRequest) {
  return {
    ...response,
    dataRequest: undefined,
    notes: [...(response.notes ?? []), 'AI Workspace không dùng dashboard dataRequest; hãy dùng dataQueries/sqlQueryPlans.'],
  };
}
```

- [ ] **Step 5: Update settings AI guidance**

In `app/src/lib/settingsRules.ts`, replace source wording:

```ts
'AI Workspace must query Supabase reporting.flight_operations through dashboard_ai_query_rows/dashboard_ai_query_aggregated. It must not use dashboard tab context, selected dashboard rows, or local SQLite as analytical context.'
```

- [ ] **Step 6: Run contract and AI tests**

Run:

```powershell
cd app
npm run test:dashboard-contract
npm run python:agent:test
npm run test:skawld-dashboard-harness
npx tsc --noEmit --pretty false
```

Expected: all commands pass. If `test:skawld-dashboard-harness` requires unavailable local credentials, record the exact failure and keep the source-contract test as the minimum gate.

---

## Task 7: Reporting Query Coverage For Dashboard Widgets

**Files:**
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/lib/operationalDashboardAnalysis.ts`
- Modify: `app/src/lib/dashboardAiAnalysis.ts`
- Modify: `app/supabase/functions/dashboard-ai-analysis/index.ts`

- [ ] **Step 1: Define widget-to-query mapping**

Add a local constant near dashboard data loading:

```ts
const DASHBOARD_REPORTING_QUERIES = {
  operationalKpis: {
    groupBy: ['type'],
    metrics: ['flights', 'pax'],
  },
  arrivalTimeline30: {
    filters: { typeFilter: 'A' },
    groupBy: ['local_bucket_30'],
    metrics: ['flights', 'pax'],
  },
  arrivalTimeline60: {
    filters: { typeFilter: 'A' },
    groupBy: ['local_bucket_60'],
    metrics: ['flights', 'pax'],
  },
  departureTimeline30: {
    filters: { typeFilter: 'D' },
    groupBy: ['local_bucket_30'],
    metrics: ['flights', 'pax'],
  },
  departureTimeline60: {
    filters: { typeFilter: 'D' },
    groupBy: ['local_bucket_60'],
    metrics: ['flights', 'pax'],
  },
  comparisonAirline: {
    groupBy: ['airline'],
    metrics: ['flights', 'pax'],
  },
  comparisonCountry: {
    groupBy: ['country'],
    metrics: ['flights', 'pax'],
  },
  comparisonRoute: {
    groupBy: ['route'],
    metrics: ['flights', 'pax'],
  },
  comparisonAcGroup: {
    groupBy: ['ac_group'],
    metrics: ['flights', 'pax'],
  },
} as const;
```

- [ ] **Step 2: Use reporting queries for AI, keep frontend analytics pure**

The dashboard UI may continue to use `loadSeasonWorkspaceWindow()` effective records for interactive local rendering. AI Workspace must not reuse those records. When AI needs the same widget insight, it must generate equivalent `dashboard_ai_query_aggregated` calls from `DASHBOARD_REPORTING_QUERIES`.

- [ ] **Step 3: Add AI query examples**

In AI function prompt/tool description, include examples:

```ts
{
  queryId: 'arrival-timeline-local-30',
  sourceView: 'flight_operations',
  filters: { seasonIds: [seasonId], dateFrom: operationalDate, dateTo: operationalDate, typeFilter: 'A' },
  groupBy: ['local_bucket_30'],
  metrics: ['flights', 'pax'],
  orderBy: 'local_bucket_30',
  orderDir: 'asc',
  limit: 96,
}
```

```ts
{
  queryId: 'wow-airline-ctg',
  sourceView: 'flight_operations',
  filters: { seasonIds: [seasonId], isoweeks: [currentIsoWeek, previousIsoWeek] },
  groupBy: ['isoweek', 'airline'],
  metrics: ['flights', 'pax'],
  orderBy: 'flights',
  orderDir: 'desc',
  limit: 500,
}
```

- [ ] **Step 4: Verify query allowlist covers all dashboard dimensions**

Run:

```powershell
cd app
npm run test:dashboard-contract
```

Expected: PASS for query-only contract and migration field coverage.

---

## Task 8: Documentation Updates

**Files:**
- Modify: `context.md`
- Modify: `architecture.md` if it contains dashboard data-flow notes

- [ ] **Step 1: Update glossary-level context**

Add a concise section to `context.md` near the dashboard/AI context:

```md
### Dashboard reporting terms

- Operational date: airport local operational day from 05:00 through 04:59 next calendar day.
- Effective flight operation: a reportable flight row after Supabase server modifications are applied, added legs are included, and deleted legs are excluded.
- CTG (%): contribution-to-growth percentage for a dimension, calculated as `dimension_diff / previous_period_total`.
- Pax missing after 1 day: `Pax = 0` is normal for future planned flights; it is missing data only after the scheduled local datetime has passed by more than 1 day.
- AI Workspace query boundary: AI Workspace does not use dashboard tab state, selected dashboard rows, or MoM/WoW UI context. It queries Supabase reporting RPCs directly per agent analysis.
```

Do not add implementation snippets to `context.md`.

- [ ] **Step 2: Update architecture only if current architecture contradicts new source boundary**

If `architecture.md` says dashboard AI uses local SQLite or dashboard payloads as analytical context, replace that with:

```md
Dashboard AI is query-first against Supabase reporting RPCs. Local UI state may identify seasons and display notebook cells, but it is not the analytical data source for AI agents.
```

- [ ] **Step 3: Scan for mojibake**

Run:

```powershell
cd ..
$pattern = ([char]0x00C3).ToString() + '|' + ([char]0x00C2).ToString() + '|á' + ([char]0x00BA).ToString() + '|' + ([char]0x00C6).ToString() + '|' + ([char]0x00C4).ToString() + '|' + ([char]0xFFFD).ToString()
rg -n $pattern context.md architecture.md docs/superpowers/plans/2026-06-23-operational-dashboard-replacement.md app/src app/supabase
```

Expected: no matches introduced by this work. Existing unrelated matches must be reviewed before editing around them.

---

## Task 9: Final Verification

**Files:**
- All files changed by Tasks 1-8

- [ ] **Step 1: Run source contract tests**

Run:

```powershell
cd app
npm run test:dashboard-contract
```

Expected: PASS.

- [ ] **Step 2: Run operational analytics tests**

Run:

```powershell
cd app
node --experimental-strip-types --test src/lib/operationalDashboardAnalysis.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run existing rule tests**

Run:

```powershell
cd app
npm run test:rules
```

Expected: `rule regression tests passed`.

- [ ] **Step 4: Run AI-side tests**

Run:

```powershell
cd app
npm run python:agent:test
```

Expected: Python unit tests pass.

- [ ] **Step 5: Run TypeScript**

Run:

```powershell
cd app
npx tsc --noEmit --pretty false
```

Expected: exit code `0`, no TypeScript errors.

- [ ] **Step 6: Run production build**

Run:

```powershell
cd app
npm run build
```

Expected: Next.js build completes successfully.

- [ ] **Step 7: Manual dashboard smoke**

Run:

```powershell
cd app
npm run dev
```

Open `/dashboard` and verify:

- `Vận hành ca trực`, `AI Workspace`, `So sánh sản lượng` tabs are visible.
- `Tổng quan` and `Phân tích MoM / WoW` tabs are gone.
- Operational date window displays `05:00 -> 04:59 +1`.
- `1h` and `30 phút` bucket toggle changes the ARR and DEP timelines.
- Local/UTC toggle changes labels but not the selected operational date.
- ARR timeline counts only `Type = A`.
- DEP timeline counts only `Type = D`.
- Pax coverage warning appears only when missing-pax policy is triggered.
- `Flights` is the default metric in `So sánh sản lượng`.
- `Pax` metric shows coverage warning.
- CTG ranking values equal `dimension_diff / previous_period_total`.
- AI Workspace can produce an analysis only through query results, not from selected dashboard rows.

---

## Self-Review

- Spec coverage: The plan replaces both existing dashboard views, keeps AI Workspace, decouples AI from dashboard context, uses Supabase effective reporting, honors operational day 05:00-04:59, supports local/UTC labels, supports 1h/30-minute timelines, keeps CTG formula, defaults comparison to Flights, handles Pax missing after 1 day, uses Settings thresholds, and uses existing A/C Groups.
- Placeholder scan: No unresolved placeholder tasks remain. Thresholds are nullable settings, not hard-coded values.
- Type consistency: `DashboardView` uses `operations | comparison | ai-workspace`; operational analytics use `30 | 60`; AI query contracts use `reporting.flight_operations` as the effective reporting compatibility view.

## Execution Recommendation

Use Subagent-Driven execution. The work splits cleanly:

1. Reporting migration and allowlist.
2. Operational analytics module and tests.
3. Settings thresholds.
4. Dashboard UI replacement.
5. AI Workspace query-only boundary.
6. Docs and full verification.
