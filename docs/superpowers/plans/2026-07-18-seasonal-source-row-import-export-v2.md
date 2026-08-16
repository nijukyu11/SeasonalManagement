# Seasonal Source-Row Import and Canonical Export V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstable Seasonal atomic-record upload with a source-row server-first import, make export consume one validated server snapshot, and repair the production data states that currently block import or export.

**Architecture:** The native client parses Excel into a strict canonical source-row contract and sends only those rows to Supabase. A versioned Postgres import V2 stages the request, expands occurrences set-wise, reconciles the imported baseline while preserving manual operational data, and commits under a season lock with idempotency and real read-back counts. After commit, the route-reload plan's shared coordinator performs the only initiating-client reconciliation by assembling sequential keyset pages from `get_season_schedule_allocation_window_v2`, fenced by the import result's `dataVersion`/`serverHighWater`. Export reads one distinct versioned full-season artifact snapshot, materializes effective legs through one shared modification and pairing resolver, validates the selected set, and only then formats the workbook in the client.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node `node:test`, SheetJS `xlsx`, Zustand 5, Supabase JS 2, self-hosted Supabase Postgres, SQL/PLpgSQL, Tauri 2, PowerShell.

---

## Confirmed Baseline

- The application is server-first. Supabase is the durable source of truth; SQLite/native catch-up must not participate in Seasonal import or export.
- The current W26 import sends 26,631 atomic records twice, once as `flightRecords` and once as `flight_records`, producing an estimated request body of roughly 52 MB.
- Production logs on 2026-07-14 contain two `POST /rpc/apply_seasonal_import_remote` responses with `57014: canceling statement due to statement timeout`. The `authenticated` role has `statement_timeout=8s`.
- The production `apply_seasonal_import_remote(p_import jsonb)` reads source rows and flight records but ignores `modificationDeleteRecordIds`.
- Production `season_source_rows` is empty for S25, S26, W25, and W26.
- S26 contains two duplicate baseline groups on 2026-06-10: PR585 and PR586. They are currently hidden by deletion state, so changing modification behavior before repairing the baseline can expose export failures.
- W25 contains 8,165 records marked `source_kind='added'` and one active JX703 record linked to a missing JX704 record.
- The current worktree already contains user changes in `AGENTS.md`, `app/src/lib/detailedScheduleState.ts`, `app/src/lib/detailedScheduleState.test.ts`, and an untracked route reload plan. Do not overwrite or revert them.
- Runtime evidence supplied on 2026-07-20 shows bursts of seven simultaneous workspace-read V1 calls that saturate CPU and cross the same 8-second timeout. Import V2 removes the oversized write; `2026-07-13-server-first-route-reload-hardening.md` owns the read-side V2 paging/single-flight fix. They ship as one client campaign.

---

## Fixed Product Policies

1. A Seasonal workbook is a complete imported baseline for one season, not a partial patch file.
2. Import and export operate only on committed server state. When a Seasonal draft exists, the user must Save or Discard before either action.
3. Re-import replaces source-owned schedule fields: date, time, route, aircraft, flight identity, category, code shares, international/domestic indicator, and turnaround metadata.
4. Re-import preserves operational fields for a matched occurrence: pax, gate, stand, counter, carousel, MCT, FB, LB, BHS, GHS, and check-in allocation windows.
5. Manual `source_kind='added'` flights are preserved unless they collide with an imported occurrence key. A collision blocks preview and names both records; it is never resolved by first-row-wins behavior.
6. A deleted or schedule-modified imported occurrence is restored to the workbook baseline on re-import. Operational-only modifications are rebased and retained.
7. The occurrence uniqueness rule remains the current visible contract: within one season and scheduled calendar date, `airline + normalized flight number` may occur once.
8. New record IDs are deterministic and season-namespaced. Existing matched IDs remain stable during migration so counters, history, and operational modifications are not orphaned.
9. Export must reject zero matched records, unknown selected IDs, malformed/truncated snapshots, duplicate occurrences, and unresolved or ambiguous pairs.
10. No import or export error may silently fall back to SQLite, a native local table, or the old non-atomic Settings full-replace sequence.
11. `commit_seasonal_import_v2` is the only import write and `revalidateSeasonWorkspaceAfterMutation()` is the only initiating-client post-commit schedule read. The import handler never launches a direct workspace load or publishes a second refresh trigger.

---

## Target Request Flow

```text
XLSX file
  -> client parses and normalizes source rows
  -> client rejects structural or row diagnostics
  -> stage_seasonal_import_v2(requestId, checksum, expectedVersion, rows)
  -> server validates and expands a preview set
  -> client commits the staged batch
  -> commit_seasonal_import_v2 locks season and reconciles in one transaction
  -> server returns actual row counts, record counts, dataVersion, and high-water
  -> client advances the workspace generation once
  -> coordinator assembles one complete token-fenced workspace-read V2 page chain
  -> coordinator commits the complete snapshot before the import handler continues
```

```text
Export command
  -> require no draft and a season-scoped selection
  -> get_seasonal_export_snapshot_v2(seasonId, expectedVersion)
  -> reject malformed, truncated, stale, empty, or unmatched snapshot
  -> materialize effective legs once
  -> resolve pair closure once
  -> duplicate + pair + round-trip validation
  -> client formats and saves XLSX
```

---

## Cross-Plan Integration Boundary

This plan and `2026-07-13-server-first-route-reload-hardening.md` retain separate task IDs and RPC responsibilities, but they have one client cutover and one release gate:

```text
Route Tasks 1-5 + Import Tasks 1-5
  -> Route Task 5A tracked workspace-read V2 SQL/assembler
  -> Route Task 6 shared coordinator
  -> Import Task 6 + Route Task 7 one client cutover
  -> remaining tasks from both plans
  -> combined load/fault verification
  -> deploy Import V2 SQL, then workspace-read V2 SQL
  -> schema-cache reload -> authenticated smoke -> native canary
```

The two legacy RPC names are not interchangeable:

- `apply_seasonal_import_remote` is **Import V1** and may be revoked only after the Import V2 canary gate.
- `get_season_schedule_allocation_window_v1` is **workspace-read V1** and remains callable for old signed clients through the separate route-plan compatibility window.

"Fix once" means one coordinated signed app release. The database migrations still deploy additively before that client so a new app never calls a missing function.

The route plan's finalized herd policy is part of this release gate: automatic realtime/TTL refresh uses full-jitter `100-300ms`, `snapshot_changed` waits full-jitter `250-1000ms` and restarts at most once, while manual/post-import reconciliation starts immediately. Do not add shared server page caching unless the seven-client gate fails; if it fails, the immutable pinned cache becomes mandatory before release and all capacity/completeness tests rerun.

---

## File Structure

### Canonical source rows and client safety

- Create: `app/src/lib/seasonalSourceRowValidation.ts`
- Create: `app/src/lib/seasonalSourceRowValidation.test.ts`
- Create: `app/src/lib/seasonalFileActionGuard.ts`
- Create: `app/src/lib/seasonalFileActionGuard.test.ts`
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/parser.ts`
- Modify: `app/src/lib/parser.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/seasonalDetailedDraftSave.source.test.ts`

### Server import V2

- Create: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Create: `app/supabase/tests/seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Create: `app/src/lib/seasonalImportRpcContract.ts`
- Create: `app/src/lib/seasonalImportRpcContract.test.ts`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

### Effective legs, pairing, and export

- Create: `app/src/lib/effectiveSeasonalLegs.ts`
- Create: `app/src/lib/effectiveSeasonalLegs.test.ts`
- Create: `app/src/lib/seasonalPairing.ts`
- Create: `app/src/lib/seasonalPairing.test.ts`
- Create: `app/src/lib/seasonalExportSelection.ts`
- Create: `app/src/lib/seasonalExportSelection.test.ts`
- Modify: `app/src/lib/detailedScheduleState.ts`
- Modify: `app/src/lib/detailedScheduleState.test.ts`
- Modify: `app/src/lib/atomicSchedule.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs`
- Modify: `app/src/lib/exporter.ts`
- Modify: `app/src/lib/exporter.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`

### Repair, verification, and legacy removal

- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-audit.sql`
- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-repair.sql`
- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md`
- Modify: `app/src/app/settings/page.tsx`
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`
- Modify: `app/package.json`
- Modify: `architecture.md`

---

### Task 1: Define and Test the Canonical Source-Row Contract

**Files:**
- Create: `app/src/lib/seasonalSourceRowValidation.ts`
- Create: `app/src/lib/seasonalSourceRowValidation.test.ts`
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/parser.ts`
- Modify: `app/src/lib/parser.test.ts`

- [ ] **Step 1: Write failing date, time, DOW, header, and zero-flight tests**

Add tests that construct workbooks in memory and cover the exact failures from the audit:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { parseSeasonalSchedule } from './parser.ts';

function workbook(row: Record<string, unknown>, sheetName = 'S27'): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet([row]);
  return { SheetNames: [sheetName], Sheets: { [sheetName]: sheet } };
}

const validRow = {
  Effective: '01-Mar-27', Discontinue: '31-Mar-27', Airline: 'VN', Aircraft: '321',
  Mon: 1, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0,
  STA: '', ARRFlight: '', ARRRoute: '', STD: '10:30', DEPFlight: '123', DEPRoute: 'HAN',
};

test('seasonal parser normalizes uppercase month names and Excel serial dates to ISO', () => {
  const uppercase = parseSeasonalSchedule(workbook({ ...validRow, Effective: '01-MAR-27' }));
  const serial = parseSeasonalSchedule(workbook({ ...validRow, Effective: 46417, Discontinue: 46447 }));
  assert.equal(uppercase.rows[0].effective, '2027-03-01');
  assert.match(serial.rows[0].effective, /^2027-\d{2}-\d{2}$/);
  assert.deepEqual(uppercase.issues, []);
  assert.deepEqual(serial.issues, []);
});

test('seasonal parser accepts real Excel booleans for days of operation', () => {
  const result = parseSeasonalSchedule(workbook({ ...validRow, Mon: true }));
  assert.equal(result.rows[0].daysOfWeek[0], true);
  assert.deepEqual(result.issues, []);
});

test('seasonal parser rejects rows that generate no flight occurrence', () => {
  const result = parseSeasonalSchedule(workbook({
    ...validRow,
    Mon: false,
    Tue: false,
    Wed: false,
    Thu: false,
    Fri: false,
    Sat: false,
    Sun: false,
  }));
  assert.equal(result.issues.some((issue) => issue.code === 'no-operating-days'), true);
});

test('seasonal parser rejects invalid calendar dates and reversed periods', () => {
  const invalid = parseSeasonalSchedule(workbook({ ...validRow, Effective: '31-Apr-27' }));
  const reversed = parseSeasonalSchedule(workbook({
    ...validRow,
    Effective: '31-Mar-27',
    Discontinue: '01-Mar-27',
  }));
  assert.equal(invalid.issues.some((issue) => issue.code === 'invalid-effective-date'), true);
  assert.equal(reversed.issues.some((issue) => issue.code === 'reversed-date-range'), true);
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run from `app`:

```powershell
node --experimental-strip-types --test src/lib/parser.test.ts src/lib/seasonalSourceRowValidation.test.ts
```

Expected: FAIL because `ParseResult.issues` and strict normalization do not exist.

- [ ] **Step 3: Add explicit issue types to the domain contract**

Extend `app/src/lib/types.ts` with this exact public shape:

```ts
export type SeasonalSourceRowIssueCode =
  | 'missing-header'
  | 'invalid-effective-date'
  | 'invalid-discontinue-date'
  | 'reversed-date-range'
  | 'invalid-time'
  | 'invalid-day-value'
  | 'no-operating-days'
  | 'missing-airline'
  | 'missing-aircraft'
  | 'incomplete-flight-side'
  | 'no-flight-side';

export interface SeasonalSourceRowIssue {
  code: SeasonalSourceRowIssueCode;
  rowIndex: number | null;
  column: string | null;
  message: string;
}

export interface ParseResult {
  seasonCode: string;
  rows: ParsedRow[];
  issues: SeasonalSourceRowIssue[];
}
```

- [ ] **Step 4: Implement one strict normalization module**

Implement and export these functions from `app/src/lib/seasonalSourceRowValidation.ts`:

```ts
export function normalizeSeasonalDate(value: unknown): string | null;
export function normalizeSeasonalTime(value: unknown): string | null;
export function normalizeSeasonalDay(value: unknown): { value: boolean; valid: boolean };
export function validateSeasonalSourceRow(row: ParsedRow): SeasonalSourceRowIssue[];
export const REQUIRED_SEASONAL_HEADERS: readonly string[];
```

Implementation rules:

```ts
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const REQUIRED_SEASONAL_HEADERS = [
  'Effective', 'Discontinue', 'Airline', 'Aircraft',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'STA', 'ARRFlight', 'ARRRoute', 'STD', 'DEPFlight', 'DEPRoute',
] as const;
```

Use `XLSX.SSF.parse_date_code` for numeric dates, UTC construction for text dates, and verify the UTC year/month/day after construction so JavaScript cannot roll `31-Apr` into May. Accept month names case-insensitively and ISO `YYYY-MM-DD`. Accept DOW values `true`, `false`, numeric `1/0`, and strings `TRUE/FALSE/1/0`; every other non-empty value is invalid. Accept times only when the normalized result is within `00:00` through `23:59`.

- [ ] **Step 5: Make `parseSeasonalSchedule` return only canonical rows plus diagnostics**

Update `app/src/lib/parser.ts` so every accepted row contains ISO dates, strict `HH:mm` times, seven validated booleans, uppercased airline/aircraft/route values, and at least one complete ARR or DEP side. Do not silently skip a non-empty row with a missing airline; emit a row diagnostic. Detect missing required headers before mapping rows.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
node --experimental-strip-types --test src/lib/parser.test.ts src/lib/seasonalSourceRowValidation.test.ts
```

Expected: PASS with all date, time, DOW, header, and zero-flight cases covered.

- [ ] **Step 7: Commit the canonical parser boundary**

```powershell
git add app/src/lib/types.ts app/src/lib/parser.ts app/src/lib/parser.test.ts app/src/lib/seasonalSourceRowValidation.ts app/src/lib/seasonalSourceRowValidation.test.ts
git commit -m "fix: validate canonical seasonal source rows"
```

---

### Task 2: Block Unsafe Draft, Import, and Export State

**Files:**
- Create: `app/src/lib/seasonalFileActionGuard.ts`
- Create: `app/src/lib/seasonalFileActionGuard.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/seasonalDetailedDraftSave.source.test.ts`

- [ ] **Step 1: Write failing pure guard tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getSeasonalFileActionBlock, reconcileSeasonalSelection } from './seasonalFileActionGuard.ts';

test('import and export are blocked while a Seasonal draft exists', () => {
  assert.equal(getSeasonalFileActionBlock({ action: 'import', hasDraftChanges: true, busy: false })?.code, 'draft');
  assert.equal(getSeasonalFileActionBlock({ action: 'export', hasDraftChanges: true, busy: false })?.code, 'draft');
});

test('selection reconciliation rejects unknown ids instead of validating an empty export', () => {
  assert.deepEqual(reconcileSeasonalSelection(['S26-old'], new Set(['W26-current'])), {
    matchedIds: [],
    unknownIds: ['S26-old'],
  });
});
```

- [ ] **Step 2: Run the guard tests and verify RED**

```powershell
node --experimental-strip-types --test src/lib/seasonalFileActionGuard.test.ts
```

Expected: FAIL because the guard module does not exist.

- [ ] **Step 3: Implement the pure guard**

```ts
export interface SeasonalFileActionBlock {
  code: 'busy' | 'draft' | 'no-selection' | 'stale-selection';
  message: string;
}

export function getSeasonalFileActionBlock(input: {
  action: 'import' | 'export';
  hasDraftChanges: boolean;
  busy: boolean;
  selectedCount?: number;
}): SeasonalFileActionBlock | null {
  if (input.busy) return { code: 'busy', message: 'Another Seasonal operation is still running.' };
  if (input.hasDraftChanges) {
    return { code: 'draft', message: `Save or discard the Seasonal draft before ${input.action}.` };
  }
  if (input.action === 'export' && (input.selectedCount ?? 0) === 0) {
    return { code: 'no-selection', message: 'Select at least one flight before export.' };
  }
  return null;
}

export function reconcileSeasonalSelection(selectedIds: string[], availableIds: Set<string>) {
  return {
    matchedIds: selectedIds.filter((id) => availableIds.has(id)),
    unknownIds: selectedIds.filter((id) => !availableIds.has(id)),
  };
}
```

- [ ] **Step 4: Apply the guard at both UI entry points**

In `SeasonalSchedulePage.tsx`:

- Run the guard before opening the import file picker and again at the start of `handleFile`.
- Run the guard before any export request.
- Reject any parser issue before calculating records or calling the server.
- Call `setSelectedRecordIds(new Set())` when the active season changes, after a successful import, and after a server reload removes selected IDs.
- Call `setDraftState(null)` only after a committed import snapshot has been applied.
- Disable Import and Export buttons when `hasDraftChanges` is true.
- Remove the misleading dirty-import choice that says local changes were discarded without actually clearing the draft.

- [ ] **Step 5: Add source assertions for the page wiring**

Extend `seasonalDetailedDraftSave.source.test.ts` to assert that both file actions use `getSeasonalFileActionBlock`, both buttons include `hasDraftChanges`, and `handleSeasonChange` resets `selectedRecordIds`.

- [ ] **Step 6: Run the focused guard and source tests**

```powershell
node --experimental-strip-types --test src/lib/seasonalFileActionGuard.test.ts src/app/seasonalDetailedDraftSave.source.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the UI safety boundary**

```powershell
git add app/src/lib/seasonalFileActionGuard.ts app/src/lib/seasonalFileActionGuard.test.ts app/src/app/SeasonalSchedulePage.tsx app/src/app/seasonalDetailedDraftSave.source.test.ts
git commit -m "fix: block unsafe seasonal file actions"
```

---

### Task 3: Add Versioned Import Batch Tables and Staging RPC

**Files:**
- Create: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Create: `app/supabase/tests/seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Add failing schema source assertions**

Add a test that reads the migration and requires these objects:

```ts
assert.match(migrationSource, /create table if not exists public\.season_import_batches/);
assert.match(migrationSource, /client_id text not null/);
assert.match(migrationSource, /create table if not exists public\.season_import_batch_rows/);
assert.match(migrationSource, /create or replace function public\.stage_seasonal_import_v2\(p_import jsonb\)/);
assert.match(migrationSource, /public\.app_operator_has_permission\('seasonal\.write'\)/);
assert.doesNotMatch(migrationSource, /for\s+v_record\s+in\s+select.*jsonb_array_elements\(.*flightRecords/is);
```

- [ ] **Step 2: Run the source test and verify RED**

```powershell
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because the V2 migration is absent.

- [ ] **Step 3: Create additive batch tables**

The migration must create these tables without altering V1:

```sql
create table if not exists public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  client_id text not null,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  checksum text not null,
  status text not null check (status in ('staged', 'validated', 'committed', 'failed')),
  source_row_count integer not null default 0,
  generated_record_count integer not null default 0,
  diagnostics jsonb not null default '[]'::jsonb,
  result jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create table if not exists public.season_import_batch_rows (
  batch_id uuid not null references public.season_import_batches(batch_id) on delete cascade,
  row_index integer not null,
  row_data jsonb not null,
  primary key (batch_id, row_index)
);
```

Enable RLS, deny direct authenticated table writes, and grant authenticated users only `execute` on the RPCs. The RPC must check `seasonal.write`; the later repair RPC must check `season.repair`.

- [ ] **Step 4: Implement idempotent staging**

`stage_seasonal_import_v2(p_import jsonb)` must:

1. Require `requestId`, `clientId`, `checksum`, `seasonCode`, and a non-empty `sourceRows` JSON array. Persist `clientId` on the batch; it must come from the same `getOrCreateSeasonClientId()` identity used by `SeasonSyncProvider`.
2. Return the existing batch when `request_id` already exists with the same checksum.
3. Raise a conflict when a reused request ID has a different checksum.
4. Insert source rows with one `INSERT INTO season_import_batch_rows SELECT` statement sourced from `jsonb_array_elements`.
5. Validate required canonical fields and store row-specific diagnostics.
6. Return `batchId`, `status`, `sourceRowCount`, `diagnostics`, and `valid` using camelCase keys only.

- [ ] **Step 5: Add rollback-safe SQL tests**

Create `app/supabase/tests/seasonal_source_import_v2.sql` with `begin;` at the start and `rollback;` at the end. Cover an empty row array, duplicate request ID with equal checksum, duplicate request ID with a different checksum, and one valid canonical source row. Use `do $$ begin` assertion blocks that raise a concrete exception on mismatch so `psql -v ON_ERROR_STOP=1` fails immediately.

- [ ] **Step 6: Mirror the migration into schema.sql**

Place the table and function definitions in `app/supabase/schema.sql` after the Seasonal relational tables. Keep migration and schema signatures byte-for-byte equivalent for public columns and RPC names.

- [ ] **Step 7: Run source verification and commit**

```powershell
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
git add app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql app/supabase/tests/seasonal_source_import_v2.sql app/supabase/schema.sql app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: stage canonical seasonal source imports"
```

---

### Task 4: Expand Source Rows to Atomic Records Set-Wise

**Files:**
- Modify: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Modify: `app/supabase/tests/seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Write failing SQL parity fixtures**

Add fixtures for:

- A departure-only row operating Monday across two weeks.
- A same-row same-day ARR/DEP pair.
- A same-row overnight pair where departure scheduled date is anchor date plus one.
- Two explicitly linked source rows.
- Flight numbers `81`, `LJ81`, and `LJ081`, all yielding `LJ081`.
- A source overlap that generates the same `season + date + airline + flight number` twice and must produce a blocking diagnostic.

For each fixture assert generated count, normalized number, scheduled date, operational date, reciprocal `linked_record_id`, one `turnaround_id`, and no duplicate occurrence keys.

- [ ] **Step 2: Add deterministic SQL helper functions**

Add immutable helpers with these signatures:

```sql
public.normalize_seasonal_flight_number_v2(p_airline text, p_raw text)
returns table (flight_number text, raw_flight_number text)

public.seasonal_operational_date_v2(p_scheduled_date date, p_schedule time)
returns date

public.seasonal_record_id_v2(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
)
returns text
```

`seasonal_record_id_v2` must include a stable hash of `season_id` and the occurrence identity. It must not include row index, route, schedule, or aircraft.

- [ ] **Step 3: Implement one set-producing generator**

Create:

```sql
public.generate_seasonal_import_records_v2(p_batch_id uuid)
returns table (
  record_id text,
  occurrence_key text,
  link_id text,
  type text,
  airline text,
  flight_number text,
  raw_flight_number text,
  route text,
  schedule text,
  aircraft text,
  category text,
  code_shares text,
  int_dom_ind text,
  scheduled_date text,
  operational_date text,
  day_of_week integer,
  source_row_index integer,
  linked_source_row_index integer,
  link_type text,
  pair_anchor_date text,
  linked_record_id text,
  turnaround_id text
)
```

The function must be `language sql stable`. Build the result with CTEs in this order: canonical batch rows, `generate_series(effective, discontinue, interval '1 day')`, DOW filtering, ARR/DEP side expansion, pair-anchor resolution, normalized flight identity, deterministic IDs, reciprocal link IDs, and duplicate-key diagnostics. Do not use a PL/pgSQL loop over generated atomic records.

- [ ] **Step 4: Add preview validation and generated counts**

Update staging so a valid batch calls the generator, stores `generated_record_count`, and changes status to `validated`. A zero generated count, duplicate occurrence key, missing linked row, or ambiguous pair keeps the batch uncommittable and records diagnostics.

- [ ] **Step 5: Run SQL tests against an isolated Postgres database**

```powershell
psql "$env:SEASONAL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260718090000_seasonal_source_import_v2.sql
psql "$env:SEASONAL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/seasonal_source_import_v2.sql
```

Expected: both commands exit 0; fixture assertions pass; the test transaction rolls back.

- [ ] **Step 6: Commit the set-based generator**

```powershell
git add app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql app/supabase/tests/seasonal_source_import_v2.sql app/supabase/schema.sql
git commit -m "feat: generate seasonal atomic records on server"
```

---

### Task 5: Commit Import V2 Atomically and Rebase Operational State

**Files:**
- Modify: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Modify: `app/supabase/tests/seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Add failing transaction, idempotency, and rebase tests**

Cover these database behaviors:

1. A stale `expectedDataVersion` rejects without changing any Seasonal table.
2. Recommitting one batch returns the original result, does not increment version twice, and does not insert a second change event.
3. Matching imported occurrences retain existing record IDs and operational fields.
4. Source-owned modifications are cleared on re-import.
5. Operational-only modifications survive with corrected `changed_fields`.
6. Omitted imported occurrences are removed.
7. Manual-added occurrences survive unless their occurrence key collides with the import; a collision blocks the transaction.
8. Any raised exception rolls back source rows, atomic records, modifications, season metadata, and change event together.

- [ ] **Step 2: Implement the commit RPC**

Create the public RPC `public.commit_seasonal_import_v2(p_batch_id uuid, p_expected_data_version integer) returns jsonb` as `language plpgsql security definer set search_path = public`. Its body must implement every operation in the ordered checklist below without invoking the V1 import function.

The implementation must:

- Check `seasonal.write` and take `pg_advisory_xact_lock(hashtextextended(season_id, 0))`.
- Create the season for a new import or compare `p_expected_data_version` to the current `data_version`.
- Reject any batch not in `validated` status or containing blocking diagnostics.
- Materialize generated records into a temporary table with a unique occurrence key.
- Match legacy records by `season_id + date + airline + normalized flight number`; reject more than one active match.
- Preserve the matched record ID and operational columns.
- Replace all `source_kind='imported'` records absent from the generated baseline.
- Preserve `source_kind='added'` records and reject collisions.
- Delete source-owned or deleted modifications for affected imported IDs while retaining operational-only fields and child counter/window rows.
- Replace `season_source_rows` and `season_source_row_days` from the staged batch.
- Update `seasons.total_legs`, `total_source_rows`, effective bounds, file name, upload timestamp, `data_version`, and `last_synced_at` from actual committed rows.
- Insert exactly one `season_change_events` import event with `client_id=batch.client_id` and `op_id=request_id`, and use its sequence as `serverHighWater`. Idempotent recommit returns the stored result without another event.
- Mark the batch `committed` and return camelCase keys only.

The success response contract is:

```json
{
  "batchId": "uuid",
  "seasonId": "season-id",
  "seasonCode": "W26",
  "status": "committed",
  "sourceRowCount": 450,
  "flightRecordCount": 26631,
  "preservedOperationalCount": 12,
  "removedImportedCount": 4,
  "dataVersion": 8,
  "serverHighWater": 12345,
  "checksum": "sha256"
}
```

- [ ] **Step 3: Add a read-back verification query inside the transaction**

Before returning, count committed source rows and imported atomic rows from their real tables and compare them to the staged/generated counts. Raise an exception on mismatch. Do not return payload lengths as verification.

- [ ] **Step 4: Prove rollback and idempotency in SQL tests**

Run the same `psql` commands from Task 4. Expected: all new transaction assertions pass and the test database has no persisted fixture rows after rollback.

- [ ] **Step 5: Commit the atomic server transaction**

```powershell
git add app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql app/supabase/tests/seasonal_source_import_v2.sql app/supabase/schema.sql
git commit -m "feat: commit seasonal source imports atomically"
```

---

### Task 6: Cut the Client Import Adapter Over to Source Rows Only

**Files:**
- Create: `app/src/lib/seasonalImportRpcContract.ts`
- Create: `app/src/lib/seasonalImportRpcContract.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`

- [ ] **Step 1: Write failing RPC contract tests**

```ts
test('import V2 rejects a response without real server counts', () => {
  assert.throws(() => parseSeasonalImportV2Result({ status: 'committed' }), /sourceRowCount/);
});

test('import V2 accepts the exact committed server result', () => {
  const result = parseSeasonalImportV2Result({
    batchId: '00000000-0000-0000-0000-000000000001',
    seasonId: 'season-w26',
    seasonCode: 'W26',
    status: 'committed',
    sourceRowCount: 450,
    flightRecordCount: 26631,
    preservedOperationalCount: 0,
    removedImportedCount: 0,
    dataVersion: 2,
    serverHighWater: 10,
    checksum: 'abc',
  });
  assert.equal(result.flightRecordCount, 26631);
});
```

- [ ] **Step 2: Define the V2 client types**

Replace the atomic-record import input in `remoteStore.ts` with:

```ts
export interface RemoteSeasonalImportInput {
  requestId: string;
  clientId: string;
  checksum: string;
  seasonId?: string | null;
  seasonCode: string;
  expectedDataVersion: number | null;
  fileName: string;
  uploadedAt: number;
  sourceRows: ParsedRow[];
  actor?: RemoteActor | null;
}

export interface RemoteSeasonalImportResult {
  batchId: string;
  seasonId: string;
  seasonCode: string;
  status: 'committed';
  sourceRowCount: number;
  flightRecordCount: number;
  preservedOperationalCount: number;
  removedImportedCount: number;
  dataVersion: number;
  serverHighWater: number;
  checksum: string;
}
```

- [ ] **Step 3: Implement strict runtime parsing**

`seasonalImportRpcContract.ts` must validate every required string and finite non-negative count. It must reject snake-case-only, missing, null, and malformed responses. It must never substitute client payload lengths.

The same module must build a stable SHA-256 checksum from `seasonCode + canonical sourceRows` and derive a UUID-form request ID from `seasonId + expectedDataVersion + checksum`. Retrying the same canonical file against the same season version must therefore reuse the request ID; importing after a committed version change must produce a new request ID.

- [ ] **Step 4: Replace compatibility calls with the exact V2 sequence**

`supabaseStore.applySeasonalImportRemote` must:

1. Run the originating operator-epoch checkpoint, then call `stage_seasonal_import_v2` with `{ p_import: payload }`, including `clientId`.
2. Reject staging diagnostics or a non-validated status.
3. Run the same checkpoint again after stage and immediately before calling `commit_seasonal_import_v2` with `p_batch_id` and `p_expected_data_version`.
4. Parse the response through `parseSeasonalImportV2Result`, then run the checkpoint again before returning/progress or any client cache write.

Remove `flightRecords`, `flight_records`, duplicated camel/snake payload keys, `callSeasonalImportRpcRawPayload`, and every V1 signature fallback from this path.

- [ ] **Step 5: Simplify the Seasonal page import handler**

Remove client write dependencies on `flattenRowsToFlightRecords`, `mergeDuplicateImportRecords`, `buildSeasonalImportPatch`, and `modificationDeleteRecordIds`. Send the validated source rows, request ID, shared season client ID, checksum, expected version, file name, and upload timestamp. After commit and an operator-epoch check, update season metadata from the returned values and call exactly once:

```ts
await revalidateSeasonWorkspaceAfterMutation(windowInput, {
  operatorSessionEpoch,
  generationAlreadyAdvanced: false,
  expectedSnapshot: {
    dataVersion: importResult.dataVersion,
    serverHighWater: importResult.serverHighWater,
  },
});
```

The coordinator owns the complete sequential workspace-read V2 page chain and commits it before resolving. Never pass pre-RPC arrays, directly call `loadSeasonWorkspaceWindow()`/`replaceSeasonWindow()`/page-owned `applySeasonData()`, or publish another refresh-triggering workspace event. The initiating client ignores its own realtime import event by `clientId` and relies on this explicit reconciliation; other clients each persist one invalidation and start at most one logical load for the resulting generation.

If commit succeeds but reconciliation fails, show `Import committed, refresh failed` with season ID and batch ID, keep the committed result and stale visible snapshot, and offer Refresh. Do not display `Import Failed` or automatically retry the commit. An epoch change after stage prevents commit; an epoch change after a successful commit suppresses old-operator UI/cache/reconciliation work but does not relabel the server commit as failed.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonalImportRpcContract.test.ts src/lib/seasonalImportModeGuard.test.ts src/lib/parser.test.ts src/lib/seasonalFileActionGuard.test.ts
```

Expected: PASS; source assertions prove no atomic array or raw Import V1 fallback remains, `getOrCreateSeasonClientId()` supplies `clientId`, and exactly one `revalidateSeasonWorkspaceAfterMutation()` replaces every direct post-import workspace load.

- [ ] **Step 7: Commit the client cutover**

```powershell
git add app/src/lib/seasonalImportRpcContract.ts app/src/lib/seasonalImportRpcContract.test.ts app/src/lib/remoteStore.ts app/src/lib/supabaseStore.ts app/src/lib/seasonalImportModeGuard.test.ts app/src/app/SeasonalSchedulePage.tsx
git commit -m "feat: import seasonal schedules from source rows"
```

---

### Task 7: Unify Effective-Leg Materialization and Pair Resolution

**Files:**
- Create: `app/src/lib/effectiveSeasonalLegs.ts`
- Create: `app/src/lib/effectiveSeasonalLegs.test.ts`
- Create: `app/src/lib/seasonalPairing.ts`
- Create: `app/src/lib/seasonalPairing.test.ts`
- Modify: `app/src/lib/detailedScheduleState.ts`
- Modify: `app/src/lib/detailedScheduleState.test.ts`
- Modify: `app/src/lib/atomicSchedule.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.ts`
- Modify: `app/src/lib/exporter.ts`

- [ ] **Step 1: Write failing effective-leg tests**

Cover a base record and `action='added'` modification with the same ID, a modified 04:00 flight crossing the operational-date boundary, and a deleted record. Assert one materialized leg per ID, recomputed schedule metadata, and no deleted leg.

- [ ] **Step 2: Implement one materializer**

Export:

```ts
export function materializeEffectiveSeasonalLegs(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>
): FlightLeg[];
```

Use a map keyed by leg ID. Base records take precedence over legacy duplicate `addedLeg` values with the same ID. Apply modifications once. When schedule or route changes, recompute `scheduledTime`, `operationalDate`, `iataSeasonCode`, `flightSeriesId`, `dayOfWeek`, and other metadata through `buildOperationalFlightMetadata`. Filter deleted records once at the end.

- [ ] **Step 3: Write failing pair-resolution tests**

Cover reciprocal `linkedRecordId`, valid turnaround fallback, valid anchor fallback, missing counterpart, ambiguous four-leg turnaround group, and selecting one overnight leg. Assert one pair, automatic counterpart closure, or an explicit issue; never silently select an arbitrary candidate.

- [ ] **Step 4: Implement the shared pair resolver**

```ts
export interface SeasonalPairIssue {
  code: 'missing-counterpart' | 'non-reciprocal-link' | 'ambiguous-pair';
  legId: string;
  message: string;
}

export interface SeasonalPairResolution {
  pairs: Array<{ arrival: FlightLeg; departure: FlightLeg }>;
  unpaired: FlightLeg[];
  issues: SeasonalPairIssue[];
  byLegId: Map<string, string>;
}

export function resolveSeasonalPairs(legs: FlightLeg[]): SeasonalPairResolution;
export function closeSeasonalSelectionOverPairs(
  selectedIds: string[],
  resolution: SeasonalPairResolution
): string[];
```

Resolution priority is reciprocal direct IDs, then a unique two-leg `turnaroundId`, then a unique two-leg `linkId + pairAnchorDate + linkType`. Any group with more than two active legs is ambiguous.

- [ ] **Step 5: Replace all competing implementations**

Make `detailedScheduleState.applyModificationsToFlightLegs` delegate to the materializer. Make `atomicSchedule.includeLinkedLegsForExport`, `canonicalSeasonalRows`, and `exporter.validateFlightLegsForSeasonalExport` use `resolveSeasonalPairs`. Remove local pairing fallbacks that encode different rules.

- [ ] **Step 6: Run focused tests**

```powershell
node --experimental-strip-types --test src/lib/effectiveSeasonalLegs.test.ts src/lib/seasonalPairing.test.ts src/lib/detailedScheduleState.test.ts src/lib/exporter.test.ts
```

Expected: PASS, including the existing uncommitted turnaround copy regression after integrating it rather than overwriting it.

- [ ] **Step 7: Commit the shared effective state**

```powershell
git add app/src/lib/effectiveSeasonalLegs.ts app/src/lib/effectiveSeasonalLegs.test.ts app/src/lib/seasonalPairing.ts app/src/lib/seasonalPairing.test.ts app/src/lib/detailedScheduleState.ts app/src/lib/detailedScheduleState.test.ts app/src/lib/atomicSchedule.ts app/src/lib/canonicalSeasonalRows.ts app/src/lib/exporter.ts app/src/lib/exporter.test.ts
git commit -m "fix: unify seasonal effective legs and pairing"
```

---

### Task 8: Add a Versioned Export Snapshot and Strict Selection Contract

**Files:**
- Modify: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`
- Create: `app/src/lib/seasonalExportSelection.ts`
- Create: `app/src/lib/seasonalExportSelection.test.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`

- [ ] **Step 1: Write failing selection and identity tests**

Cover stale IDs after switching S26 to W26, a zero-match selection, a snapshot with missing arrays, a snapshot with `truncated=true`, and the exact legacy identity `airline='LJ', flightNumber='81', rawFlightNumber='81'`. The LJ fixture must round-trip as `LJ081` without a missing or extra occurrence.

- [ ] **Step 2: Add a dedicated export snapshot RPC**

Create:

```sql
public.get_seasonal_export_snapshot_v2(
  p_season_id text,
  p_expected_data_version integer
)
returns jsonb
```

The RPC must check `seasonal.read`, hold one repeatable-read statement snapshot, verify the expected season version, return all base records and modifications needed for effective materialization, and include `totalCount`, `dataVersion`, `serverHighWater`, and `truncated=false`. It must not filter by `operational_date`, paginate by a non-unique date key, or return an empty array because a field name changed.

- [ ] **Step 3: Implement strict client snapshot parsing**

Do not use `snapshotArray(value) => []` for export. Reject missing arrays, non-finite counts, `truncated !== false`, a base-record array whose length differs from `totalCount`, and a data version that differs from the requested version.

- [ ] **Step 4: Normalize occurrence identity before validation**

Create one helper that calls `cleanFlightNumber(airline, flightNumber || rawFlightNumber)` and use its canonical `flightNumber` in duplicate keys and round-trip occurrence signatures. Keep raw flight number only for workbook cells.

- [ ] **Step 5: Scope selection to season and snapshot**

Represent export selection as:

```ts
export interface SeasonalExportSelection {
  seasonId: string;
  dataVersion: number;
  mode: 'ids' | 'all';
  recordIds: string[];
}
```

For `mode='ids'`, every selected ID must exist in the snapshot before pair closure. For `mode='all'`, select the complete effective snapshot rather than the rows currently mounted in the table. Reject a final effective set of zero legs.

- [ ] **Step 6: Replace the page export handler**

The handler must block drafts, fetch the V2 snapshot, validate selection, materialize effective legs, close the selection over resolved pairs, check duplicates and pair issues, run canonical round-trip validation, then save XLSX. It must show all blocking issue categories with the first concrete flight/date and must never download a blank workbook.

- [ ] **Step 7: Run export tests**

```powershell
node --experimental-strip-types --test src/lib/seasonalExportSelection.test.ts src/lib/exporter.test.ts
node scripts/rule-regression-tests.cjs
```

Expected: PASS; the `LJ|81` fixture no longer reports `Missing 1 occurrence`.

- [ ] **Step 8: Commit the export snapshot boundary**

```powershell
git add app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql app/supabase/schema.sql app/src/lib/seasonalExportSelection.ts app/src/lib/seasonalExportSelection.test.ts app/src/lib/supabaseStore.ts app/src/lib/remoteStore.ts app/src/lib/canonicalSeasonalRows.ts app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs app/src/app/SeasonalSchedulePage.tsx
git commit -m "fix: export one validated seasonal server snapshot"
```

---

### Task 9: Repair Production Data Before Enforcing Constraints

**Files:**
- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-audit.sql`
- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-repair.sql`
- Create: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md`
- Modify: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Write a read-only audit artifact**

The audit must report by season:

- Baseline and effective counts by `source_kind` and status.
- Duplicate occurrence keys from both base records and effective legs.
- Orphan and non-reciprocal links.
- Turnaround groups with a cardinality other than two.
- Modifications whose leg ID has no base or added-leg owner.
- IDs present in both base records and legacy added modifications.
- Non-normalized flight numbers.
- Source-row counts and source rows that generate no occurrence.

Each query must include season code, record IDs, flight/date labels, and count; no query may mutate data.

- [ ] **Step 2: Write a transaction-safe repair artifact**

The repair script must:

1. Assert the known season IDs and expected pre-repair counts.
2. Copy affected rows into timestamped tables in the `maintenance` schema.
3. Resolve the S26 PR585/PR586 duplicate baselines by preserving the effective canonical record and backing up the discarded record plus child rows.
4. Reclassify W25 records from `added` to `imported` only after the audit proves they form the complete imported baseline.
5. Clear the W25 JX703 orphan metadata or restore a verified counterpart; never fabricate a flight.
6. Repair ambiguous turnaround groups by preserving only verified reciprocal pairs.
7. Remove orphan modifications and duplicate base/added materialization only when the backup and expected-count assertions succeed.
8. End with all audit queries returning zero blocking rows.

Wrap mutations in `begin;` and leave `commit;` as the final explicit statement. Include a documented dry-run mode that executes all assertions and ends with `rollback;`.

- [ ] **Step 3: Run the audit and dry-run through SSH**

Copy only the SQL artifact to the server and execute it with `psql -v ON_ERROR_STOP=1`. Do not place the SSH password in the repository, command history, or verification document. Save redacted query outputs and timestamps in the verification artifact.

- [ ] **Step 4: Apply the repair after reviewing dry-run output**

Require exact agreement between audit expectations and live counts before changing `rollback` to `commit`. Immediately rerun the audit after commit.

- [ ] **Step 5: Add constraints after cleanup**

Add an active imported-baseline uniqueness index matching the application occurrence rule and server-side collision checks for manual-added modifications. Add supporting indexes for `(season_id, date, airline, flight_number)`, `(season_id, operational_date)`, and `(season_id, turnaround_id)`.

- [ ] **Step 6: Commit artifacts and constraints**

```powershell
git add docs/superpowers/artifacts/2026-07-18-seasonal-import-export-audit.sql docs/superpowers/artifacts/2026-07-18-seasonal-import-export-repair.sql docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql app/supabase/schema.sql
git commit -m "fix: repair seasonal import and export data integrity"
```

---

### Task 10: Retire Legacy Full-Replace and Import V1 Compatibility Paths

**Files:**
- Modify: `app/src/app/settings/page.tsx`
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`
- Modify: `app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql`
- Modify: `architecture.md`

- [ ] **Step 1: Write failing source-boundary tests**

Require the Settings repair import to call the V2 source-row transaction and reject these symbols from Seasonal import paths: `clearSeasonBaseline`, `batchWriteFlightRecords`, `callSeasonalImportRpcRawPayload`, V1 `apply_seasonal_import_remote`, and any `queryNative`, `importNative`, or SQLite catch-up call.

- [ ] **Step 2: Route Settings repair through V2**

Keep the visible `Seasonal Full Replace` label, but make the action run strict parsing, stage, preview, and commit V2 under the `season.repair` permission. Remove the destructive clear-then-batch-write sequence.

- [ ] **Step 3: Remove client compatibility paths**

Delete Import V1 payload types, fallback signatures, raw PostgREST fetch, false payload-count verification, and direct source-row mutation APIs that conflict with the staged import contract. Keep source rows readable as import provenance; do not expose arbitrary row-by-row editing. Do not remove or revoke `get_season_schedule_allocation_window_v1`; that separate workspace-read compatibility lifecycle belongs to the route plan.

- [ ] **Step 4: Retire Import V1 only after the canary client is live**

At the end of the import migration, revoke execute on Import V1 `apply_seasonal_import_remote` from authenticated users. Keep its SQL definition for one release rollback window, then drop it in a later migration after production verification. Do not make the Import V2 client fall back to Import V1. This decision does not authorize revoking workspace-read V1.

- [ ] **Step 5: Update architecture documentation**

Document source rows as imported baseline, atomic records as server-generated occurrences, modifications as operational overlays, and Supabase as the only normal persistence boundary. State explicitly that SQLite is not an import, export, retry, or failure fallback.

- [ ] **Step 6: Run boundary tests and commit**

```powershell
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
node scripts/rule-regression-tests.cjs
git add app/src/app/settings/page.tsx app/src/app/settings/components/SeasonRepairTab.tsx app/src/lib/supabaseStore.ts app/src/lib/remoteStore.ts app/src/lib/seasonalImportModeGuard.test.ts app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql architecture.md
git commit -m "refactor: retire legacy seasonal import paths"
```

---

### Task 11: Add Integration, Load, Fault, and Round-Trip Verification

**Files:**
- Create: `app/scripts/seasonal-import-v2-load-test.mjs`
- Create: `app/scripts/seasonal-import-export-roundtrip.mjs`
- Create: `app/scripts/run-seasonal-import-v2-db-test.mjs`
- Modify: `app/package.json`
- Modify: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md`

- [ ] **Step 1: Add package commands**

```json
{
  "test:seasonal-import-v2-db": "node scripts/run-seasonal-import-v2-db-test.mjs",
  "test:seasonal-import-v2-load": "node scripts/seasonal-import-v2-load-test.mjs",
  "test:seasonal-roundtrip": "node scripts/seasonal-import-export-roundtrip.mjs"
}
```

`run-seasonal-import-v2-db-test.mjs` must require `SEASONAL_TEST_DATABASE_URL`, invoke `psql` through `spawnSync` with argument-array quoting, run the tracked migration followed by the SQL test file, and exit with the first non-zero child status.

- [ ] **Step 2: Implement the W26 load harness**

The load test must stage the real normalized W26 source rows against an isolated database, record request byte size, preview duration, commit duration, generated count, and duplicate count. It must fail when the source-row request contains `flightRecords`, exceeds 5 MB, produces zero records, returns `57014`, or yields a count different from the verified W26 fixture.

- [ ] **Step 3: Implement workbook round-trip verification**

For S26 and W26 fixtures: import source rows, fetch export snapshot, build canonical rows, write an in-memory workbook, parse it again, preview the re-import, and compare sorted occurrence signatures. Fail on any missing/extra occurrence, duplicate key, unresolved pair, empty workbook, or count mismatch.

- [ ] **Step 4: Add fault injection cases**

Verify network failure before stage, after stage, during commit response delivery, and during post-commit refresh. Assert that retrying a request ID cannot duplicate or recommit data and that a committed-refresh failure is reported as committed.

Also run the route plan's combined reconciliation/capacity cases:

- one successful import commit creates one event and one initiating-client logical workspace-read V2 chain, not direct + coordinator + realtime chains;
- an initiating realtime echo is ignored by `clientId`; a second client persists one invalidation and starts at most one chain;
- seven same-process consumers share one strict coordinator promise, while seven independent authenticated clients run at most seven page statements total at once;
- pages inside each chain are sequential, every chain reaches `hasMore=false`, and all clients assemble identical token/ID/count sets with no duplicate/missing roots;
- the unchanged 8-second timeout produces zero `57014`, page p95 below 2 seconds, and maximum page latency below 4 seconds;
- workspace-read V2 timeout/network failure produces no workspace-read V1 or direct-table request; only a confirmed missing V2 signature may make one workspace-read V1 compatibility call.

- [ ] **Step 5: Run the complete verification matrix**

```powershell
node --experimental-strip-types --test src/lib/parser.test.ts src/lib/seasonalSourceRowValidation.test.ts src/lib/seasonalFileActionGuard.test.ts src/lib/seasonalImportRpcContract.test.ts src/lib/effectiveSeasonalLegs.test.ts src/lib/seasonalPairing.test.ts src/lib/seasonalExportSelection.test.ts src/lib/exporter.test.ts
npm run test:rules
npx tsc --noEmit --pretty false
npx eslint src/lib/parser.ts src/lib/seasonalSourceRowValidation.ts src/lib/seasonalFileActionGuard.ts src/lib/seasonalImportRpcContract.ts src/lib/effectiveSeasonalLegs.ts src/lib/seasonalPairing.ts src/lib/seasonalExportSelection.ts src/app/SeasonalSchedulePage.tsx
npm run build
npm run test:seasonal-import-v2-db
npm run test:seasonal-import-v2-load
npm run test:seasonal-roundtrip
```

Expected: every command exits 0, W26 has no timeout or duplicate, and S26/W26 round-trip signatures match exactly.

- [ ] **Step 6: Commit verification tooling**

```powershell
git add app/scripts/seasonal-import-v2-load-test.mjs app/scripts/seasonal-import-export-roundtrip.mjs app/scripts/run-seasonal-import-v2-db-test.mjs app/package.json docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md
git commit -m "test: verify seasonal import export v2 end to end"
```

---

### Task 12: Deploy Additively, Canary Native, and Release Updater

**Files:**
- Modify: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md`
- Modify during release: `app/package.json`
- Modify during release: `app/src-tauri/tauri.conf.json`

- [ ] **Step 1: Capture pre-deploy state**

Record the current server migration checksum, RPC signatures, role timeouts, S26/W26 season versions, row counts, duplicate audit, and latest successful native version. Confirm the working tree contains only intended implementation commits plus preserved user changes.

- [ ] **Step 2: Deploy additive SQL first**

Apply the tracked Import V2 migration, then the route plan's tracked workspace-read V2 migration, to the self-hosted Supabase server. Verify Import V1 and workspace-read V1 remain callable during their distinct compatibility windows, both V2 permission contracts are correct, and staging a one-row fixture succeeds without changing a season.

Run from the repository root:

```powershell
Get-Content -Raw -Encoding UTF8 app/supabase/migrations/20260718090000_seasonal_source_import_v2.sql | ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1"
Get-Content -Raw -Encoding UTF8 app/supabase/migrations/20260720090000_workspace_window_keyset_v2.sql | ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1"
```

Expected: both `psql` calls exit 0. Reload the PostgREST schema cache, then query `pg_proc`, grants, indexes, and table metadata to confirm both exact V2 signatures and batch tables exist. Run authenticated preview-only Import V2 and first-page workspace-read V2 smoke calls before installing any new client.

- [ ] **Step 3: Run production preview-only shadow checks**

Stage S26 and W26 source rows without commit. Compare generated counts, occurrence hashes, pair diagnostics, and request sizes to the current effective schedules. Do not proceed when preview has a blocking difference that is not explained by the approved repair artifact.

- [ ] **Step 4: Apply and verify data repair**

Run the approved repair transaction, rerun the read-only audit, and record maintenance backup table names. Confirm zero blocking duplicate, orphan, ambiguous pair, and source-kind findings.

- [ ] **Step 5: Build and test a canary native version**

```powershell
npm run native:build
```

Install the canary on one clean machine. Test new-season import, same-season re-import, draft blocking, exactly one token-fenced refresh-after-commit, full-season Detailed with blank From/To, repeated route navigation, select-all export, subset export, S26/W26 round-trip, and application restart. Confirm no SQLite/catch-up log line appears and that the import's realtime echo does not start a second logical window chain.

- [ ] **Step 6: Monitor before retiring Import V1**

Monitor PostgREST/Kong/Postgres logs for `57014`, 409 version conflicts, malformed snapshot/page errors, duplicate diagnostics, request sizes, page latency/concurrency, and sustained CPU. Require successful S26 and W26 import/export/reconciliation smoke results before revoking execute on Import V1 `apply_seasonal_import_remote`. Do not revoke workspace-read V1 here.

- [ ] **Step 7: Pass the seven-client workspace-read capacity gate**

Run the route plan's seven-client barrier test against the canary backend. Require zero `57014`, at most seven simultaneous page statements, identical complete results, page p95 below 2 seconds, maximum below 4 seconds, and no sustained CPU above the documented threshold. Do not publish the updater if the metrics cannot be captured or the gate fails.

- [ ] **Step 8: Bump version and publish the updater release**

Use the repository release script to move the current `0.1.10` baseline to `0.1.11`, keep Next, Cargo, and Tauri versions aligned, rerun the native build, publish signed updater assets and `latest.json`, and verify the previous installed version discovers and installs the update.

```powershell
npm run release:version -- 0.1.11
npm run native:build
```

- [ ] **Step 9: Commit release metadata**

```powershell
git add app/package.json app/src-tauri/tauri.conf.json docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md
git commit -m "release: publish seasonal import export v2"
```

---

## Definition of Done

- The client sends canonical source rows only; no atomic record array is present in the request.
- W26 import completes without `57014` and without increasing the global authenticated role timeout as the primary fix.
- Repeating one request ID or importing the same file does not create, move, or duplicate records.
- A committed import runs exactly one initiating-client token-fenced coordinated workspace-read V2 chain; the complete committed snapshot is applied before reconciliation resolves and the import realtime echo starts no duplicate chain.
- Draft import/export is blocked until Save or Discard.
- Export rejects stale selection, empty output, malformed/truncated snapshots, duplicates, and pair ambiguity.
- Full and selected S26/W26 exports succeed after approved data repair.
- Exported S26/W26 workbooks re-import with identical occurrence signatures.
- Production has no effective duplicate, orphan link, ambiguous turnaround group, base/added duplicate materialization, or non-normalized active flight identity.
- `season_source_rows` is populated for seasons imported through V2.
- Settings repair uses the same atomic V2 path.
- No Seasonal import/export path reads or writes SQLite.
- Seven independent workspace clients complete under the unchanged 8-second timeout with zero `57014`, bounded sequential page concurrency, identical complete snapshots, and the route plan's latency/CPU gates.
- Focused tests, `test:rules`, TypeScript, targeted ESLint, web build, both SQL integrations, W26 load, workspace-read V2 load, round-trip, native build, updater installation, and production smoke checks all pass.

---

## Rollback Boundaries

- Database deployment is additive until canary verification completes; neither Import V1 nor workspace-read V1 is dropped in the same migrations.
- A failed commit transaction rolls back automatically and leaves the staged batch available for diagnosis.
- Data repair is reversible from named maintenance backup tables created in the same transaction.
- The import client does not fall back to Import V1 or SQLite. The workspace-read client may call workspace-read V1 exactly once only when the workspace-read V2 signature is confirmed missing; timeout/network failure never selects it.
- Roll back the app by reinstalling the previous signed release while retaining both workspace-read versions. Do not drop workspace-read V2 while a new client exists or workspace-read V1 while an old client exists.
- The previous signed native updater release remains available until the new release passes clean-machine smoke testing.

---

## Execution Notes

- Execute in an isolated Superpowers worktree so the existing uncommitted `detailedScheduleState` and plan changes are preserved.
- Use RED -> GREEN -> focused verification -> commit for every task.
- Do not combine production data repair with code deployment before preview-only parity succeeds.
- Do not raise the global `authenticated` statement timeout to hide row-by-row processing.
- Execute Import Task 6 and Route Task 7 as one client cutover after Route Task 5A and Task 6 are green; do not release a direct post-import workspace load in between.
- Do not store SSH credentials, Supabase service keys, or updater signing keys in plan artifacts or shell scripts.
