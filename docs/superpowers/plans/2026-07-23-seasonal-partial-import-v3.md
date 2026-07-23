# Seasonal Partial Import V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution status (2026-07-23):** Tasks 1-10 are implemented and verified.
Task 11 production deployment and signed updater publication are complete at
`app-v0.1.15`. The remaining acceptance items are a clean-machine update and
an operator decision for 16 legitimate manual `KE2094` collisions found by the
corrected Book3 preview; V3 intentionally does not delete those records.

**Goal:** Add an explicit, previewed Seasonal import workflow where `merge` upserts only occurrence keys present in the workbook, `replace` remains a separately authorized destructive repair action, and neither path can silently fall back to SQLite or commit through the legacy V2 full-replace contract.

**Architecture:** Keep the released Import V2, Export V2, and workspace-window V2 contracts stable for signed `0.1.14` clients. Add V3 RPCs and durable staged atomic records so one server-generated preview is the exact input to commit; the client sends canonical source rows only, displays the server preview, and never commits automatically. Merge updates imported baseline rows for incoming occurrence keys while preserving all overlays and omitted occurrences; replace uses the current repair semantics but exposes every removal and overlay-clear count before requiring explicit confirmation.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node `node:test`, SheetJS `xlsx`, Zustand 5, Supabase JS 2, self-hosted Supabase PostgreSQL 17, SQL/PLpgSQL, Tauri 2, PowerShell.

---

## Execution Baseline

- Start implementation from `origin/main` commit `0cf06e5`, which contains released application version `0.1.14`.
- Do not implement from the dirty `codex/route-reload-port` checkout or copy its uncommitted Import V2 snapshots.
- Create the implementation worktree with `superpowers:using-git-worktrees`.
- Preserve the signed `app-v0.1.14` updater and all V2 functions during the rollout window.
- Use Supabase as the only durable authority. Seasonal import, preview, commit, status, cancel, refresh, and export must not read or write SQLite.
- Do not raise the global `authenticated` role timeout from 8 seconds.
- Do not resume or commit production batch `c0269785-e583-4b41-8136-db7972f347cc`.

Current production facts that must be rechecked immediately before any mutation:

- `stage_seasonal_import_v2` and `commit_seasonal_import_v2` expose only `standard|repair`; no merge strategy exists.
- Batch `c0269785-e583-4b41-8136-db7972f347cc` is `validated`, has 11 source rows and 98 generated occurrences, and still matches S26 `dataVersion=16573`.
- S26 has no complete `season_source_rows` snapshot. A partial import must not claim that its source rows represent the full season.
- Workspace-window V2, Export V2 identity fields, schedule-time normalization, and the deleted-overlay guard are deployed and become regression gates rather than implementation work.

---

## Superseded V2 Policies

This plan supersedes these policies only for the new V3 client path:

1. A workbook is no longer assumed to be a complete season baseline.
2. Seasonal page import defaults to `merge`, not full replacement.
3. Merge never restores a deleted occurrence or clears a structural/operational overlay.
4. Omission from a merge workbook means preserve, not delete.
5. Changing an occurrence identity key creates a new occurrence; merge does not infer that an omitted old key should be moved or deleted.

The existing V2 plan remains the historical design for the released V2 functions.

---

## Fixed Product Policies

1. The preview requires an explicit strategy: `merge` or `replace`.
2. `merge` is the default and requires `seasonal.write`.
3. `replace` requires `season.repair`, a valid preview, and typed confirmation of the season code.
4. Strategy determines authorization on the server. V3 does not accept a client-controlled permission mode.
5. The client uploads canonical source rows only. Atomic records are generated once and stored by the server during stage.
6. Commit consumes the persisted staged records and preview hash. It does not regenerate a second atomic set.
7. A batch is fenced by `expectedDataVersion`; a season change after preview invalidates commit and requires a new stage.
8. Merge touches only incoming occurrence keys, preserves matched record IDs, and preserves every existing modification and child allocation row.
9. Replace may remove omitted imported records and clear source-owned/deleted overlays according to the current repair semantics, but the preview must expose exact counts before confirmation.
10. Manual `source_kind='added'` collisions block both strategies. The server never resolves them with first-row-wins behavior.
11. Invalid stage diagnostics are returned as structured preview data. They are not flattened into one exception string.
12. Resume/Check is status-only in V3. It never stages and commits automatically.
13. After commit, the initiating client performs exactly one token-fenced `revalidateSeasonWorkspaceAfterMutation()` call.
14. Export V2 and workspace-window V2 response shapes remain unchanged because released clients validate exact fields.

---

## Target Flow

```text
XLSX
  -> client parses canonical source rows
  -> operator selects merge or replace
  -> stage_seasonal_import_v3(sourceRows, strategy, expectedDataVersion)
  -> server validates and generates atomic records once
  -> server persists atomic records, diagnostics, preview counts, and previewHash
  -> client displays preview
  -> invalid preview: commit disabled; operator cancels or selects a corrected file
  -> valid merge: operator confirms
  -> valid replace: operator types season code and confirms
  -> commit_seasonal_import_v3(batchId, expectedDataVersion, previewHash)
  -> server locks the season, applies the persisted staged set atomically, and records one event
  -> client reconciles exactly one V2 workspace page chain using dataVersion/serverHighWater
```

Recovery flow:

```text
network result unknown
  -> get_seasonal_import_v3_status(requestId)
  -> validated: show the same preview; never auto-commit
  -> committed: run the committed-refresh path
  -> failed/cancelled/expired: clear pending action and show the persisted result
```

---

## V3 Contract

Create the following client contract without modifying V2 interfaces:

```ts
export type SeasonalImportV3Strategy = 'merge' | 'replace';
export type SeasonalImportV3BatchStatus =
  | 'validated'
  | 'failed'
  | 'committed'
  | 'cancelled'
  | 'expired';

export interface SeasonalImportV3Attempt {
  contractVersion: 3;
  requestId: string;
  checksum: string;
  strategy: SeasonalImportV3Strategy;
  seasonId: string | null;
  seasonCode: string;
  expectedDataVersion: number;
  fileName: string;
  uploadedAt: number;
  sourceRows: CanonicalSeasonalSourceRow[];
}

export interface SeasonalImportV3PreviewCounts {
  sourceRowCount: number;
  generatedOccurrenceCount: number;
  insertCount: number;
  baselineUpdateCount: number;
  unchangedCount: number;
  preservedOutsideScopeCount: number;
  preservedOverlayCount: number;
  preservedDeletedOverlayCount: number;
  removeImportedCount: number;
  clearStructuralOverlayCount: number;
  clearDeletedOverlayCount: number;
  manualCollisionCount: number;
}

export interface SeasonalImportV3Diagnostic {
  code: string;
  message: string;
  sourceRowIndexes: number[];
  occurrenceKey: string | null;
  affectedDateCount: number;
  sampleDates: string[];
}

export interface SeasonalImportV3StageResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  strategy: SeasonalImportV3Strategy;
  status: Exclude<SeasonalImportV3BatchStatus, 'committed'>;
  valid: boolean;
  expectedDataVersion: number;
  previewHash: string;
  counts: SeasonalImportV3PreviewCounts;
  diagnosticCount: number;
  diagnosticsTruncated: boolean;
  diagnostics: SeasonalImportV3Diagnostic[];
  expiresAt: string;
}

export interface SeasonalImportV3CommittedResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  strategy: SeasonalImportV3Strategy;
  status: 'committed';
  previewHash: string;
  counts: SeasonalImportV3PreviewCounts;
  importedRecordCount: number;
  totalEffectiveRecordCount: number;
  dataVersion: number;
  serverHighWater: number;
  checksum: string;
}
```

Required count invariants:

```text
insertCount + baselineUpdateCount + unchangedCount = generatedOccurrenceCount
merge.removeImportedCount = 0
merge.clearStructuralOverlayCount = 0
merge.clearDeletedOverlayCount = 0
manualCollisionCount > 0 => valid = false
diagnosticCount > 0 => valid = false
```

---

## File Structure

### Client contract and preview state

- Create: `app/src/lib/seasonalImportV3Contract.ts`
- Create: `app/src/lib/seasonalImportV3Contract.test.ts`
- Create: `app/src/lib/seasonalImportPreview.ts`
- Create: `app/src/lib/seasonalImportPreview.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/seasonalImportReceipt.ts`
- Modify: `app/src/lib/seasonalImportReceipt.test.ts`
- Modify: `app/src/lib/seasonalImportRecovery.ts`
- Modify: `app/src/lib/seasonalImportRecovery.test.ts`

### Database V3

- Create: `app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql`
- Create: `app/supabase/tests/seasonal_partial_import_v3.sql`
- Create: `app/supabase/tests/seasonal_partial_import_v3_pglite.mjs`
- Modify: `app/package.json`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

### Seasonal UI

- Create: `app/src/app/components/SeasonalImportPreviewDialog.tsx`
- Create: `app/src/app/components/SeasonalImportPreviewDialog.source.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx:1629-1868`
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`
- Modify: `app/src/app/seasonalDetailedDraftSave.source.test.ts`

### Verification and release

- Create: `app/scripts/run-seasonal-import-v3-db-test.mjs`
- Create: `app/scripts/seasonal-import-v3-load-test.mjs`
- Create: `app/scripts/seasonal-import-v3-book3-shadow.mjs`
- Modify: `app/package.json`
- Modify: `app/scripts/rule-regression-tests.cjs`
- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `docs/backend-supabase-schema-functions.md`
- Create: `docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md`

---

### Task 1: Define the V3 Contract and Request Identity

**Files:**
- Create: `app/src/lib/seasonalImportV3Contract.ts`
- Create: `app/src/lib/seasonalImportV3Contract.test.ts`
- Test: `app/src/lib/seasonalImportRpcContract.test.ts`

- [ ] **Step 1: Write failing strict-parser tests**

Add tests for:

```ts
test('V3 stage accepts invalid structured previews without throwing', () => {
  const result = parseSeasonalImportV3StageResult({
    batchId: BATCH_ID,
    requestId: REQUEST_ID,
    seasonId: SEASON_ID,
    seasonCode: 'S26',
    strategy: 'merge',
    status: 'failed',
    valid: false,
    expectedDataVersion: 16573,
    previewHash: HASH,
    counts: previewCounts({ manualCollisionCount: 1 }),
    diagnosticCount: 1,
    diagnosticsTruncated: false,
    diagnostics: [{
      code: 'manual-occurrence-collision',
      message: 'Incoming occurrence collides with a manual added flight.',
      sourceRowIndexes: [4],
      occurrenceKey: `${SEASON_ID}|2026-06-06|KC|KC259`,
      affectedDateCount: 1,
      sampleDates: ['2026-06-06'],
    }],
    expiresAt: '2026-07-24T12:00:00.000Z',
  });
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
});
```

Also reject unknown fields, missing counts, negative counts, invalid UUIDs, invalid strategy, an empty preview hash, and inconsistent count equations.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```powershell
cd app
node --experimental-strip-types --test src/lib/seasonalImportV3Contract.test.ts
```

Expected: FAIL because the V3 module and parser do not exist.

- [ ] **Step 3: Implement exact V3 types and strict parsers**

Implement:

```ts
export function parseSeasonalImportV3StageResult(value: unknown): SeasonalImportV3StageResult;
export function parseSeasonalImportV3CommittedResult(value: unknown): SeasonalImportV3CommittedResult;
export function parseSeasonalImportV3StatusResult(value: unknown): SeasonalImportV3StageResult | SeasonalImportV3CommittedResult;
export function parseSeasonalImportV3CancelResult(value: unknown): { batchId: string; status: 'cancelled' };
```

Keep V2 parser arrays and exact-field validation unchanged.

- [ ] **Step 4: Bind strategy and contract version into request identity**

Implement:

```ts
export async function deriveSeasonalImportV3RequestId(input: {
  seasonId: string | null;
  seasonCode: string;
  expectedDataVersion: number;
  strategy: SeasonalImportV3Strategy;
  checksum: string;
}): Promise<string>;
```

Hash this stable object:

```ts
{
  contractVersion: 3,
  seasonIdentity: input.seasonId ?? input.seasonCode,
  expectedDataVersion: input.expectedDataVersion,
  strategy: input.strategy,
  checksum: input.checksum,
}
```

Tests must prove the same canonical rows and strategy reuse one request ID, while changing strategy or expected version produces a different ID.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportV3Contract.test.ts src/lib/seasonalImportRpcContract.test.ts
```

Expected: PASS with V2 tests unchanged.

- [ ] **Step 6: Commit**

```powershell
git add app/src/lib/seasonalImportV3Contract.ts app/src/lib/seasonalImportV3Contract.test.ts
git commit -m "feat: define seasonal import v3 contract"
```

---

### Task 2: Add Durable V3 Staging and Provenance Schema

**Files:**
- Create: `app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql`
- Create: `app/supabase/tests/seasonal_partial_import_v3.sql`
- Create: `app/supabase/tests/seasonal_partial_import_v3_pglite.mjs`
- Modify: `app/package.json`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Write failing schema source-contract tests**

Require these exact objects:

```ts
assert.match(sql, /contract_version smallint not null default 2/);
assert.match(sql, /apply_strategy text/);
assert.match(sql, /create table if not exists public\.season_import_batch_records_v3/);
assert.match(sql, /create table if not exists public\.season_import_batch_preimages_v3/);
assert.match(sql, /source_import_batch_id uuid/);
assert.match(sql, /source_provenance_mode text/);
assert.match(sql, /guard_legacy_existing_season_import_v3/);
```

Assert the migration does not alter or drop V2 RPC signatures.

- [ ] **Step 2: Run the source test and verify RED**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because the V3 migration does not exist.

- [ ] **Step 3: Extend batch metadata additively**

Add:

```sql
alter table public.season_import_batches
  add column if not exists contract_version smallint not null default 2,
  add column if not exists apply_strategy text,
  add column if not exists target_existed_at_stage boolean,
  add column if not exists preview jsonb,
  add column if not exists preview_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists cancelled_at timestamptz;
```

Replace the status constraint with:

```sql
check (status in ('staged', 'validated', 'committed', 'failed', 'cancelled', 'expired'))
```

Add constraints that require `apply_strategy in ('merge','replace')`, `preview`, `preview_hash`, and `expires_at` only when `contract_version=3`.

- [ ] **Step 4: Add durable staged atomic records**

Create:

```sql
create table if not exists public.season_import_batch_records_v3 (
  batch_id uuid not null references public.season_import_batches(batch_id) on delete cascade,
  occurrence_key text not null,
  generated_record_id text not null,
  source_staging_row_index integer not null,
  source_row_index integer not null,
  linked_occurrence_key text,
  record_hash text not null,
  record_data jsonb not null,
  primary key (batch_id, occurrence_key),
  unique (batch_id, generated_record_id)
);
```

Enable RLS, revoke direct `anon`/`authenticated` writes, and index `(batch_id, source_staging_row_index)`.

- [ ] **Step 5: Add commit preimages**

Create:

```sql
create table if not exists public.season_import_batch_preimages_v3 (
  batch_id uuid not null references public.season_import_batches(batch_id) on delete restrict,
  record_id text not null,
  existed_before boolean not null,
  record_data jsonb,
  modification_data jsonb,
  counter_rows jsonb not null default '[]'::jsonb,
  checkin_window_rows jsonb not null default '[]'::jsonb,
  added_leg_data jsonb,
  primary key (batch_id, record_id)
);
```

This table is forensic/rollback evidence and has no authenticated direct-read grant.

- [ ] **Step 6: Add record-level provenance without redefining source row indexes**

Add to `season_flight_records`:

```sql
source_import_batch_id uuid,
source_import_staging_row_index integer
```

Keep the existing `source_row_index` as the workbook row number. Do not make `(season_id, source_row_index)` represent partial provenance.

Add to `seasons`:

```sql
source_provenance_mode text not null default 'none'
  check (source_provenance_mode in ('none', 'full', 'fragmented')),
last_import_batch_id uuid
```

Backfill `full` only for seasons that currently have at least one `season_source_rows` row; leave current S26/W26 as `none`.

- [ ] **Step 7: Add legacy V2 existing-season commit guard**

Create a `BEFORE INSERT` trigger that sets `target_existed_at_stage` from the
locked/canonical `season_id` or `season_code` lookup when the caller did not
provide it. Backfill existing batches from the current season table, then make
V3 stage set the field explicitly from its version-fenced target lookup.

Create a `BEFORE UPDATE OF status` trigger on `season_import_batches`:

```sql
if old.contract_version = 2
  and old.target_existed_at_stage
  and old.status is distinct from 'committed'
  and new.status = 'committed'
then
  raise exception
    'Existing-season Import V2 is disabled; use Import V3 preview with merge or replace'
    using errcode = '0A000';
end if;
```

Because the trigger raises inside the V2 commit transaction, any preceding V2
baseline changes roll back. V2 new-season imports remain available during the
compatibility window even if an empty new season starts at data version zero;
an existing season is blocked regardless of its current data version.

- [ ] **Step 8: Register the V3 schema test**

Add:

```json
{
  "test:seasonal-import-v3-sql": "node supabase/tests/seasonal_partial_import_v3_pglite.mjs"
}
```

- [ ] **Step 9: Run schema tests twice**

Run:

```powershell
npm run test:seasonal-import-sql
npm run test:seasonal-import-v3-sql
npm run test:seasonal-schema-twice
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: PASS; running the canonical schema twice remains idempotent.

- [ ] **Step 10: Commit**

```powershell
git add app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql app/supabase/tests/seasonal_partial_import_v3.sql app/supabase/tests/seasonal_partial_import_v3_pglite.mjs app/package.json app/supabase/schema.sql app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: add seasonal import v3 staging schema"
```

---

### Task 3: Implement Stage, Preview, Status, and Cancel RPCs

**Files:**
- Modify: `app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql`
- Modify: `app/supabase/tests/seasonal_partial_import_v3.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Write failing SQL tests for stage**

Cover:

1. Merge requires `seasonal.write`.
2. Replace requires `season.repair`.
3. Reusing request ID with the same request returns the persisted stage result.
4. Reusing request ID with another strategy/checksum/version raises `23505`-class conflict.
5. Invalid diagnostics return `valid=false`, `status=failed`, and persisted structured diagnostics.
6. Valid stage persists one atomic row per generated occurrence.
7. Stage changes no season, baseline, modification, child, event, or version row.
8. The preview count invariant is exact.
9. Status is owner-scoped.
10. Cancel changes only `validated` or `failed` V3 batches.
11. Expired/cancelled batches cannot commit.

- [ ] **Step 2: Run PostgreSQL test and verify RED**

Run:

```powershell
npm run test:seasonal-import-v3-sql
```

Expected: FAIL because the V3 RPCs do not exist.

- [ ] **Step 3: Implement strategy-based permission checks**

The server derives permission:

```sql
if v_strategy = 'merge' then
  if not public.app_operator_has_permission('seasonal.write') then
    raise exception 'Missing required permission: seasonal.write'
      using errcode = '42501';
  end if;
elsif v_strategy = 'replace' then
  if not public.app_operator_has_permission('season.repair') then
    raise exception 'Missing required permission: season.repair'
      using errcode = '42501';
  end if;
else
  raise exception 'strategy must be merge or replace'
    using errcode = '22023';
end if;
```

- [ ] **Step 4: Generate and persist the atomic preview once**

Implement:

```sql
create or replace function public.stage_seasonal_import_v3(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
```

Use the released canonical V2 source-row validator and `generate_seasonal_import_records_v2`. Insert valid generated records into `season_import_batch_records_v3` in one set-based statement. Store a canonical `record_hash` and one batch `preview_hash` over:

```text
contractVersion + requestId + checksum + strategy + expectedDataVersion
+ sorted occurrenceKey/recordHash pairs + preview counts
```

Commit must later consume these rows; it must not call the generator.

- [ ] **Step 5: Compute preview counts from indexed occurrence identity**

For merge:

```text
insertCount = incoming keys absent from active imported baseline
baselineUpdateCount = matched keys with different source-owned field hash
unchangedCount = matched keys with equal source-owned field hash
preservedOutsideScopeCount = existing active imported count - matched key count
removeImportedCount = 0
clearStructuralOverlayCount = 0
clearDeletedOverlayCount = 0
```

For replace:

```text
removeImportedCount = existing active imported keys absent from staged set
clearStructuralOverlayCount = affected source-owned modified overlays
clearDeletedOverlayCount = affected deleted overlays
preservedOutsideScopeCount = 0
```

Count manual collisions against effective added records and return `valid=false` when nonzero.

- [ ] **Step 6: Aggregate duplicate diagnostics**

Group duplicate occurrence diagnostics by:

```text
code + sorted sourceRowIndexes + airline + normalized flight number
```

Return `affectedDateCount` and at most five sorted `sampleDates`. Do not return one message per generated date. Cap actionable diagnostic groups at 200 and set `diagnosticsTruncated=true` when more exist.

- [ ] **Step 7: Implement status and cancel**

Add:

```sql
public.get_seasonal_import_v3_status(p_request_id uuid) returns jsonb
public.cancel_seasonal_import_v3(p_batch_id uuid) returns jsonb
```

Both functions require `created_by=auth.uid()`. Cancel sets `status='cancelled'` and `cancelled_at=now()`, retains the source rows, staged atomic rows, diagnostics, and preview for forensic status reads, and never changes season data.

- [ ] **Step 8: Run focused SQL tests**

Run:

```powershell
npm run test:seasonal-import-v3-sql
npm run test:seasonal-import-sql
npm run test:seasonal-schema-twice
```

Expected: PASS for V2 and V3.

- [ ] **Step 9: Commit**

```powershell
git add app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql app/supabase/tests/seasonal_partial_import_v3.sql app/supabase/schema.sql
git commit -m "feat: stage seasonal import v3 previews"
```

---

### Task 4: Implement Atomic Merge Commit

**Files:**
- Modify: `app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql`
- Modify: `app/supabase/tests/seasonal_partial_import_v3.sql`
- Modify: `app/supabase/schema.sql`

- [ ] **Step 1: Write failing merge tests**

Construct a season with:

- one unchanged incoming imported occurrence;
- one baseline-changed incoming occurrence with operational and structural overlays;
- one deleted incoming occurrence;
- one incoming new occurrence;
- one omitted imported occurrence;
- one manual added occurrence outside the staged keys.

Assert after merge:

```text
unchanged occurrence is byte-stable
changed baseline keeps its record_id
changed baseline source-owned fields match staged record
all modifications and child rows are unchanged
deleted overlay remains deleted
new occurrence is inserted
omitted imported occurrence remains
manual added occurrence remains
season_source_rows and total_source_rows remain unchanged
source_provenance_mode becomes fragmented
one season_change_events row is inserted
data_version increments once
```

- [ ] **Step 2: Run SQL test and verify RED**

Run:

```powershell
npm run test:seasonal-import-v3-sql
```

Expected: FAIL because `commit_seasonal_import_v3` does not exist.

- [ ] **Step 3: Implement commit fencing and idempotency**

Create:

```sql
create or replace function public.commit_seasonal_import_v3(
  p_batch_id uuid,
  p_expected_data_version integer,
  p_preview_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
```

Before mutation:

1. Lock the batch owned by `auth.uid()`.
2. Return the persisted result when already committed.
3. Require `contract_version=3`, `status=validated`, `strategy=merge`, and `expires_at>now()`.
4. Require the supplied preview hash to equal the persisted hash.
5. Take the per-season advisory lock and lock the season row `FOR UPDATE`.
6. Require current `data_version=p_expected_data_version=v_batch.expected_data_version`.

- [ ] **Step 4: Save exact preimages**

Insert preimages for every matched incoming record before updating. Insert `existed_before=false` rows for every new record ID. Do not snapshot unrelated omitted records in merge.

- [ ] **Step 5: Apply baseline-only upsert**

Update matched imported records with staged source-owned fields:

```text
link_id, type, airline, flight_number, raw_flight_number, route, schedule,
aircraft, category, code_shares, int_dom_ind, date, scheduled_date,
scheduled_time, operational_date, iata_season_code, flight_series_id,
day_of_week, source_row_index, linked_source_row_index, link_type,
pair_anchor_date, linked_record_id, turnaround_id, source provenance
```

Do not update:

```text
pax, gate, stand, counter, checkIn, carousel, mct, fb, lb, bhs, ghs,
season_modifications, modification counters, modification windows,
modification history
```

Insert new imported records with deterministic staged IDs. Never delete an imported record in the merge branch.

- [ ] **Step 6: Update season metadata from committed truth**

Set:

```text
total_legs = actual effective record count
source_provenance_mode = fragmented
last_import_batch_id = batch_id
data_version = previous + 1
last_synced_at = current epoch milliseconds
```

Leave `total_source_rows`, `season_source_rows`, and `season_source_row_days` unchanged.

- [ ] **Step 7: Persist one event and result**

Insert one `season_change_events` row with:

```json
{
  "kind": "commit_seasonal_import_v3",
  "strategy": "merge",
  "batchId": "<batch>",
  "previewHash": "<hash>",
  "counts": {}
}
```

Use its sequence as `serverHighWater`, store the exact committed result on the batch, and transition the batch to `committed`.

- [ ] **Step 8: Verify merge invariants and idempotency**

Run:

```powershell
npm run test:seasonal-import-v3-sql
npm run test:seasonal-import-v2-db
```

Expected: PASS; recommitting returns the same result without another event or version increment.

- [ ] **Step 9: Commit**

```powershell
git add app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql app/supabase/tests/seasonal_partial_import_v3.sql app/supabase/schema.sql
git commit -m "feat: commit partial seasonal baseline merges"
```

---

### Task 5: Implement Confirmed Replace and Legacy Batch Safety

**Files:**
- Modify: `app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql`
- Modify: `app/supabase/tests/seasonal_partial_import_v3.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Write failing replace and legacy tests**

Verify:

1. Replace without `season.repair` fails at stage and commit.
2. Replace removes omitted imported records.
3. Replace preserves matched record IDs and operational-only overlays.
4. Replace clears source-owned structural/deleted overlays exactly as counted in preview.
5. Replace rewrites the complete `season_source_rows` snapshot and sets provenance mode `full`.
6. Replace count drift between preview and commit aborts.
7. A V2 batch whose `target_existed_at_stage=true` rolls back with SQLSTATE `0A000`.
8. A V2 new-season import with expected version zero remains callable.
9. A cancelled V2 batch cannot be resumed or committed.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run test:seasonal-import-v3-sql
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL on replace commit behavior and legacy guard coverage.

- [ ] **Step 3: Add the replace branch**

Use the persisted V3 staged records. Apply the released V2 replacement policy set-wise, but require the persisted V3 preview counts to match counts recomputed under the season lock before the first delete/update.

Replace must:

- snapshot every removed or overwritten baseline record and dependent overlay data;
- delete omitted imported records only;
- preserve manual added records unless collision validation already failed;
- preserve operational-only overlay fields for matched IDs;
- clear source-owned structural and deleted overlays reported by preview;
- replace `season_source_rows` and `season_source_row_days`;
- set `source_provenance_mode='full'` and `total_source_rows` to the actual committed source-row count.

- [ ] **Step 4: Make the legacy guard fail closed**

Assert the trigger marker and behavior in both migration and canonical schema. Keep V2 definitions and grants in place for new-season compatibility; do not add a client fallback from V3 to V2.

- [ ] **Step 5: Run the full database boundary**

Run:

```powershell
npm run test:seasonal-import-v3-sql
npm run test:seasonal-import-sql
npm run test:seasonal-import-v2-db
npm run test:seasonal-schema-twice
```

Expected: PASS with both V2 compatibility and V3 safety assertions.

- [ ] **Step 6: Commit**

```powershell
git add app/supabase/migrations/20260724090000_seasonal_partial_import_v3.sql app/supabase/tests/seasonal_partial_import_v3.sql app/supabase/schema.sql app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: gate destructive seasonal replacements"
```

---

### Task 6: Add Client Transport, Status-Only Recovery, and Receipts

**Files:**
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts:1028-1080`
- Modify: `app/src/lib/seasonalImportReceipt.ts`
- Modify: `app/src/lib/seasonalImportReceipt.test.ts`
- Modify: `app/src/lib/seasonalImportRecovery.ts`
- Modify: `app/src/lib/seasonalImportRecovery.test.ts`
- Test: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Write failing transport tests**

Require these four distinct operations:

```ts
stageSeasonalImportV3(attempt, options)
commitSeasonalImportV3(input, options)
getSeasonalImportV3Status(requestId, options)
cancelSeasonalImportV3(batchId, options)
```

Assert:

- stage never calls commit;
- status never calls stage or commit;
- no V3 operation calls V2, raw PostgREST table writes, native invoke, or SQLite;
- every operation checkpoints operator-session epoch before and after network activity;
- abort/network failures propagate without compatibility fan-out.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportV3Contract.test.ts src/lib/seasonalImportRecovery.test.ts src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because V3 transport functions do not exist.

- [ ] **Step 3: Add remote interfaces**

Add exact remote-store methods:

```ts
stageSeasonalImportV3?(
  input: SeasonalImportV3Attempt,
  options?: OperatorSessionCheckpointOptions,
): Promise<SeasonalImportV3StageResult>;

commitSeasonalImportV3?(
  input: { batchId: string; expectedDataVersion: number; previewHash: string },
  options?: OperatorSessionCheckpointOptions,
): Promise<SeasonalImportV3CommittedResult>;

getSeasonalImportV3Status?(
  requestId: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<SeasonalImportV3StageResult | SeasonalImportV3CommittedResult>;

cancelSeasonalImportV3?(
  batchId: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<{ batchId: string; status: 'cancelled' }>;
```

- [ ] **Step 4: Wire exact Supabase RPC calls**

Use:

```ts
client().rpc('stage_seasonal_import_v3', { p_import: attempt })
client().rpc('commit_seasonal_import_v3', {
  p_batch_id: input.batchId,
  p_expected_data_version: input.expectedDataVersion,
  p_preview_hash: input.previewHash,
})
client().rpc('get_seasonal_import_v3_status', { p_request_id: requestId })
client().rpc('cancel_seasonal_import_v3', { p_batch_id: batchId })
```

Parse every response through the strict V3 contract module.

- [ ] **Step 5: Store a V3 recovery receipt**

Persist only:

```ts
{
  contractVersion: 3,
  requestId,
  batchId,
  seasonId,
  seasonCode,
  strategy,
  expectedDataVersion,
  previewHash,
  status,
  committedResult,
}
```

Do not persist source rows or atomic records in session storage.

- [ ] **Step 6: Replace auto-commit recovery**

Implement recovery rules:

```text
validated -> return preview to UI
committed -> return committed result to refresh path
failed/cancelled/expired -> clear receipt after displaying status
network unknown -> keep receipt and expose Resume/Check
```

Delete any V3 path that calls an `apply...` helper from Resume/Check.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportV3Contract.test.ts src/lib/seasonalImportReceipt.test.ts src/lib/seasonalImportRecovery.test.ts src/lib/seasonalImportModeGuard.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add app/src/lib/remoteStore.ts app/src/lib/supabaseStore.ts app/src/lib/seasonalImportReceipt.ts app/src/lib/seasonalImportReceipt.test.ts app/src/lib/seasonalImportRecovery.ts app/src/lib/seasonalImportRecovery.test.ts app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: add seasonal import v3 transport"
```

---

### Task 7: Build the Explicit Import Preview Workflow

**Files:**
- Create: `app/src/app/components/SeasonalImportPreviewDialog.tsx`
- Create: `app/src/app/components/SeasonalImportPreviewDialog.source.test.ts`
- Create: `app/src/lib/seasonalImportPreview.ts`
- Create: `app/src/lib/seasonalImportPreview.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx:1629-1868`
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`
- Modify: `app/src/app/seasonalDetailedDraftSave.source.test.ts`

- [ ] **Step 1: Write failing preview-state tests**

Model:

```ts
export type SeasonalImportPreviewState =
  | { kind: 'idle' }
  | { kind: 'staging'; strategy: SeasonalImportV3Strategy }
  | { kind: 'preview'; result: SeasonalImportV3StageResult; confirmation: string }
  | { kind: 'committing'; result: SeasonalImportV3StageResult }
  | { kind: 'committed-refresh-pending'; result: SeasonalImportV3CommittedResult };
```

Test that commit is enabled only when:

```ts
result.valid
&& result.status === 'validated'
&& (result.strategy === 'merge' || confirmation === result.seasonCode)
&& !hasDraftChanges
&& !busy
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportPreview.test.ts src/app/components/SeasonalImportPreviewDialog.source.test.ts
```

Expected: FAIL because preview state and dialog do not exist.

- [ ] **Step 3: Build the preview dialog**

The dialog must contain:

- a two-option segmented control: `Merge` and `Replace`;
- count rows for insert, baseline update, unchanged, preserved outside file, removed, preserved overlays, and cleared overlays;
- grouped diagnostics;
- a disabled Commit button for invalid previews;
- a season-code text input only for replace;
- Cancel and Commit commands;
- no automatic commit on stage completion.

Use the existing dialog/modal primitives and icon library. Keep card radius at 8px or less and prevent long occurrence keys from overflowing.

- [ ] **Step 4: Split stage and commit in SeasonalSchedulePage**

Replace:

```ts
await applySeasonalImportRemote(attemptedImport, { operatorSessionEpoch });
```

with:

```ts
const preview = await stageSeasonalImportV3(attemptedImport, { operatorSessionEpoch });
setImportPreviewState({ kind: 'preview', result: preview, confirmation: '' });
```

Commit only from the dialog command:

```ts
const committed = await commitSeasonalImportV3({
  batchId: preview.batchId,
  expectedDataVersion: preview.expectedDataVersion,
  previewHash: preview.previewHash,
}, { operatorSessionEpoch });
```

- [ ] **Step 5: Handle stale preview deterministically**

When commit returns a version conflict:

1. Keep the current visible workspace snapshot.
2. Clear the staged preview receipt.
3. Run one forced server revalidation.
4. Show `Preview expired because the season changed. Stage the file again.`
5. Never retry commit automatically.

- [ ] **Step 6: Preserve one post-commit reconciliation**

Reuse the released call:

```ts
await revalidateSeasonWorkspaceAfterMutation(windowInput, {
  operatorSessionEpoch,
  generationAlreadyAdvanced: false,
  expectedSnapshot: {
    dataVersion: committed.dataVersion,
    serverHighWater: committed.serverHighWater,
  },
});
```

Do not call `loadSeasonWorkspaceWindow`, `replaceSeasonWindow`, or publish another initiating-client refresh event from the import handler.

- [ ] **Step 7: Route Settings full replace through V3**

Keep the visible `Seasonal Full Replace` label. Stage with `strategy:'replace'`, show the same preview dialog, require `season.repair`, and remove any Settings-only destructive sequence.

- [ ] **Step 8: Run UI/source tests**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportPreview.test.ts src/app/components/SeasonalImportPreviewDialog.source.test.ts src/app/seasonalDetailedDraftSave.source.test.ts src/lib/seasonalImportModeGuard.test.ts
npx tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add app/src/app/components/SeasonalImportPreviewDialog.tsx app/src/app/components/SeasonalImportPreviewDialog.source.test.ts app/src/lib/seasonalImportPreview.ts app/src/lib/seasonalImportPreview.test.ts app/src/app/SeasonalSchedulePage.tsx app/src/app/settings/components/SeasonRepairTab.tsx app/src/app/seasonalDetailedDraftSave.source.test.ts
git commit -m "feat: preview seasonal imports before commit"
```

---

### Task 8: Preserve Schedule-Time and Deleted-Overlay Invariants

**Files:**
- Modify: `app/src/lib/scheduleTime.test.ts`
- Modify: `app/src/lib/deletedOverlayGuard.source.test.ts`
- Modify: `app/src/lib/seasonalImportRecovery.test.ts`
- Modify: `app/supabase/tests/seasonal_partial_import_v3.sql`

- [ ] **Step 1: Add failing time-format tests**

Stage source rows with `1025`, `925`, `10:25`, and invalid `2500`. Assert persisted staged `record_data.schedule` is canonical `10:25`, `09:25`, `10:25`, while invalid time produces a structured diagnostic and no committable batch.

- [ ] **Step 2: Add failing deleted-overlay tests**

For merge, assert:

```text
deleted modification row remains byte-identical
effective workspace result remains deleted after commit
preservedDeletedOverlayCount equals the matched deleted overlay count
clearDeletedOverlayCount equals zero
```

For replace, assert the preview and committed result expose the exact deleted-overlay clear count before the repair action can proceed.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
node --experimental-strip-types --test src/lib/scheduleTime.test.ts src/lib/deletedOverlayGuard.source.test.ts src/lib/seasonalImportRecovery.test.ts
npm run test:seasonal-import-v3-sql
```

Expected: FAIL until V3 paths use canonical schedule formatting and preserve merge overlays.

- [ ] **Step 4: Close the invariant gaps**

Use the existing `normalizeScheduleTime`/database canonicalization at source-row and staging boundaries. Add source-contract markers proving merge SQL contains no modification deletes or updates.

- [ ] **Step 5: Run focused and full Node tests**

Run:

```powershell
node --experimental-strip-types --test src/lib/scheduleTime.test.ts src/lib/deletedOverlayGuard.source.test.ts src/lib/seasonalImportRecovery.test.ts
$tests = @(rg --files src | Where-Object { $_ -match '(?:\.source)?\.test\.ts$' })
node --experimental-strip-types --test $tests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add app/src/lib/scheduleTime.test.ts app/src/lib/deletedOverlayGuard.source.test.ts app/src/lib/seasonalImportRecovery.test.ts app/supabase/tests/seasonal_partial_import_v3.sql
git commit -m "test: preserve import time and deletion invariants"
```

---

### Task 9: Verify Diagnostics, Book3 Merge, and Export

**Files:**
- Create: `app/scripts/seasonal-import-v3-book3-shadow.mjs`
- Modify: `app/src/lib/seasonalImportPreview.test.ts`
- Modify: `app/src/lib/seasonalExportSnapshotContract.source.test.ts`
- Modify: `app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs`
- Modify: `app/src/lib/exporter.test.ts`
- Modify: `app/src/lib/seasonalExportSnapshot.test.ts`
- Modify: `docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md`

- [ ] **Step 1: Add grouped-diagnostic tests**

Generate overlapping weekly rows equivalent to the KE2093/KE2094 conflict. Assert one grouped diagnostic per source-row pair and flight identity, with `affectedDateCount` and at most five sample dates.

- [ ] **Step 2: Write the read-only Book3 shadow harness**

The script accepts:

```powershell
$env:BOOK3_XLSX_PATH = Read-Host 'Book3 workbook path'
node scripts/seasonal-import-v3-book3-shadow.mjs --file $env:BOOK3_XLSX_PATH --season S26
```

It must:

1. Parse and canonicalize source rows locally.
2. Stage `strategy=merge` through an authenticated V3 RPC.
3. Print request ID, batch ID, data version, counts, diagnostics, duration, and preview hash.
4. Never call commit.
5. Cancel the staged shadow batch after recording its result.
6. Exit nonzero on diagnostics, timeout, malformed counts, or strategy drift.

Do not commit the workbook, credentials, host, parsed source data, or personal path.

- [ ] **Step 3: Add export regression tests**

After a synthetic merge:

- full-season Export V2 still accepts `sourceRowCount=0`;
- select-all exports every effective nondeleted record once;
- subset selection closes over exact pairs;
- output round-trips to identical occurrence signatures;
- omitted baseline rows remain present in export;
- deleted-overlay rows remain absent from effective export.

- [ ] **Step 4: Run tests**

Run:

```powershell
node --experimental-strip-types --test src/lib/seasonalImportPreview.test.ts src/lib/seasonalExportSnapshotContract.source.test.ts src/lib/exporter.test.ts src/lib/seasonalExportSnapshot.test.ts
node --test src/lib/canonicalSeasonalRows.raw-flight.test.cjs
npm run test:seasonal-roundtrip
```

Expected: PASS.

- [ ] **Step 5: Run Book3 against a disposable/local V3 database**

Run the harness against a disposable database first. Expected:

```text
strategy=merge
generatedOccurrenceCount=98
removeImportedCount=0
clearStructuralOverlayCount=0
clearDeletedOverlayCount=0
diagnosticCount=0 after the corrected first three rows
commitCalled=false
```

Do not hardcode the production matched/insert/update counts because S26 changes over time.

- [ ] **Step 6: Commit**

```powershell
git add app/scripts/seasonal-import-v3-book3-shadow.mjs app/src/lib/seasonalImportPreview.test.ts app/src/lib/seasonalExportSnapshotContract.source.test.ts app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs app/src/lib/exporter.test.ts app/src/lib/seasonalExportSnapshot.test.ts docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md
git commit -m "test: verify partial seasonal import and export"
```

---

### Task 10: Add Load, Concurrency, and Fault Verification

**Files:**
- Create: `app/scripts/run-seasonal-import-v3-db-test.mjs`
- Create: `app/scripts/seasonal-import-v3-load-test.mjs`
- Modify: `app/package.json`
- Modify: `app/scripts/rule-regression-tests.cjs`
- Modify: `docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md`

- [ ] **Step 1: Add package scripts**

Add:

```json
{
  "test:seasonal-import-v3-db": "node scripts/run-seasonal-import-v3-db-test.mjs",
  "test:seasonal-import-v3-load": "node scripts/seasonal-import-v3-load-test.mjs"
}
```

- [ ] **Step 2: Add concurrency cases**

Use real PostgreSQL barriers to verify:

- two commits for the same batch create one event;
- two valid previews against one version allow only one conflicting baseline commit;
- merge and normal schedule mutation serialize on the season/version fence;
- cancel racing commit yields exactly one terminal status;
- an operator cannot status/cancel/commit another operator's batch.

- [ ] **Step 3: Add fault cases**

Inject failures:

```text
before stage request
after stage response persistence
before commit request
during commit response delivery
after committed response before workspace refresh
during status request
```

Assert there is no duplicate commit, no V2/SQLite fallback, and committed-refresh failure remains classified as committed.

- [ ] **Step 4: Add performance gates**

Measure under the real `authenticated` 8-second timeout:

```text
Book3-sized merge stage p95 < 2 seconds, max < 4 seconds
Book3-sized merge commit p95 < 2 seconds, max < 4 seconds
full S26/W26 replace stage and commit complete within an evidence-based function budget
zero SQLSTATE 57014
zero generic network fallback fan-out
```

Do not add a function-specific timeout until the load report shows the measured full-replace requirement. If required, set it only on V3 stage/replace functions and keep merge below the global 8-second budget.

- [ ] **Step 5: Run the complete automated matrix**

Run:

```powershell
npm run test:seasonal-import-v3-sql
npm run test:seasonal-import-v3-db
npm run test:seasonal-import-v3-load
npm run test:seasonal-import-v2-db
npm run test:seasonal-import-v2-load
npm run test:seasonal-roundtrip
npm run test:workspace-window-v2-db
npm run test:workspace-window-v2-load
npm run test:seasonal-schema-twice
npm run test:rules
npx tsc --noEmit --pretty false
npx eslint src/lib/seasonalImportV3Contract.ts src/lib/seasonalImportPreview.ts src/app/components/SeasonalImportPreviewDialog.tsx src/app/SeasonalSchedulePage.tsx
npm run build
```

Expected: every command exits zero; no timeout or fallback log appears.

- [ ] **Step 6: Commit**

```powershell
git add app/scripts/run-seasonal-import-v3-db-test.mjs app/scripts/seasonal-import-v3-load-test.mjs app/package.json app/package-lock.json app/scripts/rule-regression-tests.cjs docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md
git commit -m "test: harden seasonal import v3"
```

---

### Task 11: Document, Deploy, Canary, and Release

**Files:**
- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `docs/backend-supabase-schema-functions.md`
- Modify: `app/README.md`
- Modify: `docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md`
- Modify during release only: `app/package.json`
- Modify during release only: `app/package-lock.json`
- Modify during release only: `app/src-tauri/Cargo.toml`
- Modify during release only: `app/src-tauri/Cargo.lock`
- Modify during release only: `app/src-tauri/tauri.conf.json`

- [ ] **Step 1: Update current architecture documentation**

Replace the context statement that every re-import writes a complete source snapshot with:

```text
Seasonal Import V3 supports explicit merge and replace strategies. Merge updates
only incoming baseline occurrence keys, preserves omitted records and all
overlays, and records fragmented batch provenance. Replace is a season.repair
operation that writes a complete source snapshot after an explicit destructive
preview. Both paths remain server-first and reconcile through one token-fenced
workspace-window V2 load.
```

Document all four V3 RPCs, status ownership, legacy V2 existing-season guard, and provenance modes.

- [ ] **Step 2: Record production preflight read-only evidence**

Capture:

- current `origin/main` and migration SHA-256;
- exact V2/V3 RPC signatures and grants;
- role timeouts;
- S26/W26 IDs, versions, imported/added/modification/deleted counts;
- source provenance counts;
- current status and owner-scoped metadata of batch `c0269785-e583-4b41-8136-db7972f347cc`;
- 15-minute PostgreSQL/PostgREST timeout baseline.

- [ ] **Step 3: Deploy additive V3 SQL**

Apply only the tracked V3 migration with `psql -X -v ON_ERROR_STOP=1`, reload PostgREST schema cache, and verify:

```text
V2 signatures unchanged
V3 signatures callable by authenticated users with server permission checks
direct staging-table writes denied
workspace V2 and export V2 responses unchanged
legacy V2 existing-season commit guard active
```

- [ ] **Step 4: Invalidate the dangerous validated V2 batch**

In a reviewed production transaction:

1. Lock batch `c0269785-e583-4b41-8136-db7972f347cc`.
2. Assert status `validated`, committed timestamp null, source row count 11, generated count 98, and the recorded checksum.
3. Back up the batch and its rows to the named maintenance backup location.
4. Set status `cancelled` and `cancelled_at=now()`.
5. Assert V2 commit/status paths cannot commit it.
6. Commit only after every assertion passes.

- [ ] **Step 5: Run production preview-only shadow**

Stage the corrected Book3 workbook as `merge`, record live counts and preview hash, then cancel it. Require:

```text
valid=true
generatedOccurrenceCount=98
removeImportedCount=0
clearStructuralOverlayCount=0
clearDeletedOverlayCount=0
diagnosticCount=0
no season version/event/data change
```

- [ ] **Step 6: Build and install a native canary**

Run:

```powershell
cd app
npm run native:build
```

Install on one clean machine and test:

1. Book3 merge preview and cancel.
2. Book3 merge preview and commit against a disposable/canary season.
3. Replace preview denied without `season.repair`.
4. Replace confirmation requires exact season code.
5. Version conflict after preview.
6. Network interruption after commit and Resume/Check.
7. Deleted overlay remains deleted after merge.
8. `HHmm` schedule input is stored as `HH:mm`.
9. Select-all and subset export after merge.
10. Restart and route navigation with no SQLite/catch-up log.

- [ ] **Step 7: Run the final regression gate**

Run the Task 10 matrix again from the exact release commit. Confirm production logs show zero `57014`, no direct-table/SQLite import call, and one initiating-client workspace chain per commit.

- [ ] **Step 8: Bump the next updater version**

The current baseline is `0.1.14`; use `0.1.15` unless another release has already consumed that version:

```powershell
npm run release:version -- 0.1.15
npm run test:updater
npm run native:build
```

Verify package, lockfile, Cargo, and Tauri versions are identical.

- [ ] **Step 9: Commit documentation and release metadata**

```powershell
git add context.md architecture.md docs/backend-supabase-schema-functions.md app/README.md docs/superpowers/artifacts/2026-07-23-seasonal-partial-import-v3-verification.md app/package.json app/package-lock.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/tauri.conf.json
git commit -m "release: publish seasonal partial import v3"
```

- [ ] **Step 10: Publish and verify updater artifacts**

Push the implementation branch, run the existing GitHub release workflow, then verify:

```text
release is neither draft nor prerelease
latest.json version equals the release
installer URL points to the same tag
signature is non-empty
installer SHA-256 is recorded
clean-machine update from 0.1.14 succeeds
installed binary reports the new version
```

---

## Definition of Done

- Seasonal import sends canonical source rows only.
- Every import shows a server-generated preview before commit.
- Merge is the default and never removes an omitted occurrence.
- Merge preserves all modifications, child rows, and deleted overlays.
- Replace requires `season.repair`, typed season-code confirmation, and exact destructive counts.
- Preview and commit use the same persisted staged atomic records and preview hash.
- V3 Resume/Check never auto-commits.
- V2 existing-season batches cannot commit after the server guard is deployed.
- Production batch `c0269785-e583-4b41-8136-db7972f347cc` is backed up and cancelled.
- Partial provenance is recorded by batch/record and is not represented as a complete `season_source_rows` snapshot.
- Import schedule values are canonical `HH:mm`.
- Export V2 and workspace-window V2 strict response contracts remain unchanged.
- Post-commit refresh uses exactly one token-fenced workspace coordinator chain.
- Book3 produces 98 occurrences, zero removals in merge, and zero diagnostics after correction.
- Focused tests, V2/V3 database tests, load/fault tests, round-trip, workspace-window tests, rules, TypeScript, ESLint, web build, native build, canary, and updater verification pass.

---

## Rollback Boundaries

- V3 deployment is additive; do not drop V2 tables or functions in this release.
- A failed or stale commit transaction rolls back and leaves the staged batch available for status/cancel.
- The previous signed `0.1.14` installer remains available.
- Rolling back the client does not remove V3 database objects.
- Keep the V2 existing-season commit guard active during client rollback; loss of legacy existing-season import is safer than silent full replacement.
- Every committed V3 batch retains preimages for reviewed operational recovery.
- Do not expose an automatic public rollback RPC in this release. Recovery from a committed import uses the batch preimages through a reviewed maintenance transaction.
- Do not delete committed V3 batch rows or preimages until retention policy is separately approved.

---

## Self-Review Checklist

- [x] Every fixed product policy maps to at least one task and test.
- [x] `strategy` is consistently `merge|replace`; V3 has no client permission mode.
- [x] Stage, commit, status, and cancel names match across TypeScript, SQL, tests, and docs.
- [x] Merge never writes `season_source_rows`, removes imported records, or edits modifications.
- [x] Replace destructive counts are computed at stage and rechecked under commit lock.
- [x] V2 and Export V2 exact response shapes are not extended.
- [x] No task introduces SQLite/native catch-up or direct-table fallback.
- [x] No production credential, personal path, workbook, or source-row payload is committed.
- [x] No `TBD`, `TODO`, placeholder implementation, or unowned follow-up remains.
