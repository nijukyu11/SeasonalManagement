# Season Ownership Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden season ownership in the import and remote persistence layer without breaking the server-first seasonal import contract.

**Architecture:** Ship the lowest-risk safety changes first: scope destructive remote operations to `season_id`, improve duplicate `season_code` handling, and document the contract. Keep composite remote primary keys, local-mirror recovery UX, and remote import transaction work in separate branches because each touches a different operational boundary and has a different rollback story.

**Tech Stack:** Next.js, TypeScript, Supabase SQL/RPC, Tauri native SQLite mirror, `app/scripts/rule-regression-tests.cjs`, `npx tsc --noEmit --pretty false`, `npm run build`.

---

## Evaluation

Apply first:

- **Package A: no-schema safety hardening.** Scope destructive operations on tables that already have `season_id`: `season_modifications` and `season_modification_added_legs`. This reduces accidental cross-season deletes without changing the Supabase schema.
- **Package B: unique `season_code`.** Add a fail-closed migration that refuses duplicates, then creates a unique index. Improve `findSeasonByCode` duplicate error text so the UI gets a meaningful import failure.
- **Package C: docs.** Update `context.md` and `architecture.md` after Package A/B land.

Do not apply in the same branch:

- **Composite remote PK migration.** This is a breaking schema change. It must include `season_flight_records`, `season_modifications`, `season_flight_record_counters`, `season_flight_record_checkin_windows`, `season_modification_counters`, `season_modification_checkin_windows`, and `season_modification_added_legs`. The review originally named four child tables; `season_modification_added_legs` also has a global `leg_id` PK and must be included.
- **Local mirror recovery UX.** This addresses only Point L failures after the remote commit has completed. It does not fix partial remote writes.
- **Remote import transaction/RPC.** This is the real F-4/F-6 fix and should be a separate plan after Package A/B.

Important correction to the review phasing:

- The proposed “Phase 1 no schema change” cannot add `.eq('season_id', seasonId)` to `season_flight_record_counters`, `season_flight_record_checkin_windows`, `season_modification_counters`, or `season_modification_checkin_windows` because those tables currently do not have a `season_id` column. Those changes belong to the composite-PK migration package.

---

## File Structure

### Package A - No-Schema Safety Hardening

- Modify `app/src/lib/supabaseStore.ts`
  - Add a scoped-in helper for tables that already have `season_id`.
  - Scope `removeModification`, `deleteModifications`, and `season_modification_added_legs` deletes/reads by `season_id`.
  - Keep counters/windows unchanged in this package because those tables lack `season_id`.
- Modify `app/scripts/rule-regression-tests.cjs`
  - Update the exact-season ownership assertions to require season-scoped destructive deletes for tables that can support them.

### Package B - Unique Season Code

- Create `app/supabase/migrations/20260616_unique_seasons_season_code.sql`
  - Fail closed if duplicate `season_code` rows exist.
  - Add a unique index on `public.seasons(season_code)`.
- Modify `app/supabase/schema.sql`
  - Add the clean-start unique index.
- Modify `app/src/lib/supabaseStore.ts`
  - Surface duplicate `season_code` lookup errors with a useful message.
- Modify `app/scripts/rule-regression-tests.cjs`
  - Assert the migration and clean-start schema contain the unique index.

### Package C - Documentation

- Modify `context.md`
  - Add the season ownership and server-first import contract after Package A/B.
- Modify `architecture.md`
  - Add a compact note that composite remote keys remain a planned migration, not part of Package A/B.

### Future Package D - Composite Remote PK Migration

- Modify `app/supabase/schema.sql`
- Create a new Supabase migration under `app/supabase/migrations/`
- Modify `app/src/lib/supabaseRelationalMappers.ts`
- Modify `app/src/lib/supabaseStore.ts`
- Modify `app/supabase/functions/dashboard-ai-analysis/index.ts`
- Modify `app/supabase/functions/_shared/dashboardAiShared.ts`
- Modify `app/scripts/rule-regression-tests.cjs`

### Future Package E - Local Mirror Recovery UX

- Modify `app/src/app/SeasonalSchedulePage.tsx`
- Modify `app/src/lib/nativeSeasonCatchup.ts` only if a wrapper is needed around `importNativeSeasonSnapshot`
- Modify `context.md` / `architecture.md`

### Future Package F - Remote Import Transaction

- Create a Supabase RPC/migration that wraps seasonal import remote writes in one transaction.
- Modify `app/src/app/SeasonalSchedulePage.tsx` to call the RPC instead of separate remote calls.

---

## Task 0: Execution Preflight

**Files:**
- Read: `docs/superpowers/plans/2026-06-16-season-assignment-and-atomic-import-review.md`
- Read: `context.md`
- Read: `app/src/lib/supabaseStore.ts`
- Read: `app/supabase/schema.sql`
- Read: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Confirm branch/worktree state**

Run:

```powershell
git status --short
```

Expected: identify unrelated dirty files before editing. Do not revert user changes.

- [ ] **Step 2: Confirm server-first import contract**

Run:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
rg -n "Import/re-import remains server-first|A successful import writes" context.md
```

Expected: output includes the server-first import sentence currently at `context.md:176`.

- [ ] **Step 3: Confirm child table limitation**

Run:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
rg -n "create table if not exists public\.season_(flight_record|modification)_(counters|checkin_windows)|season_id text" app/supabase/schema.sql
```

Expected: the four counters/windows child tables do not carry `season_id`; do not attempt no-schema `.eq('season_id')` changes for those tables.

---

## Task 1: No-Schema Season-Scoped Deletes

**Files:**
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add failing source-text assertions**

In `app/scripts/rule-regression-tests.cjs`, near the existing exact-season ownership block around the current `tableDefinition` assertions, add this assertion:

```js
  const removeModificationStart = supabaseStoreSource.indexOf('async removeModification(seasonId: string, legId: string)');
  const removeModificationEnd = supabaseStoreSource.indexOf('async deleteModifications(seasonId: string, legIds: string[])', removeModificationStart);
  const removeModificationSource = supabaseStoreSource.slice(removeModificationStart, removeModificationEnd);
  const deleteModificationsStart = supabaseStoreSource.indexOf('async deleteModifications(seasonId: string, legIds: string[])');
  const deleteModificationsEnd = supabaseStoreSource.indexOf('async saveModificationsWithHistory', deleteModificationsStart);
  const deleteModificationsSource = supabaseStoreSource.slice(deleteModificationsStart, deleteModificationsEnd);
  const modificationChildrenStart = supabaseStoreSource.indexOf('async function writeModificationChildren');
  const modificationChildrenEnd = supabaseStoreSource.indexOf('async function readModificationChildren', modificationChildrenStart);
  const modificationChildrenSource = supabaseStoreSource.slice(modificationChildrenStart, modificationChildrenEnd);
  assert(
    removeModificationSource.includes(".from('season_modifications').delete().eq('season_id', seasonId).eq('leg_id', legId)") &&
      deleteModificationsSource.includes(".from('season_modifications').delete().eq('season_id', seasonId).in('leg_id', chunk)") &&
      modificationChildrenSource.includes(".from('season_modification_added_legs').delete().eq('season_id', seasonId).eq('leg_id', mod.legId)"),
    'Season-scoped modification deletes must filter by season_id before leg_id; no-schema pass only covers tables that already carry season_id'
  );
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
cd app
npm run test:rules
```

Expected: FAIL with `Season-scoped modification deletes must filter by season_id before leg_id`.

- [ ] **Step 3: Scope `removeModification`**

In `app/src/lib/supabaseStore.ts`, replace:

```ts
assertOk(await client().from('season_modifications').delete().eq('leg_id', legId), 'remove modification');
```

with:

```ts
assertOk(
  await client().from('season_modifications').delete().eq('season_id', seasonId).eq('leg_id', legId),
  'remove modification'
);
```

- [ ] **Step 4: Scope `deleteModifications`**

In `app/src/lib/supabaseStore.ts`, replace:

```ts
assertOk(await client().from('season_modifications').delete().in('leg_id', chunk), 'delete modifications');
```

with:

```ts
assertOk(
  await client().from('season_modifications').delete().eq('season_id', seasonId).in('leg_id', chunk),
  'delete modifications'
);
```

- [ ] **Step 5: Scope added-leg deletes**

In `app/src/lib/supabaseStore.ts`, replace:

```ts
assertOk(await client().from('season_modification_added_legs').delete().eq('leg_id', mod.legId), 'clear modification added leg');
```

with:

```ts
assertOk(
  await client().from('season_modification_added_legs').delete().eq('season_id', seasonId).eq('leg_id', mod.legId),
  'clear modification added leg'
);
```

- [ ] **Step 6: Verify Task 1**

Run:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
```

Expected: both commands pass.

- [ ] **Step 7: Checkpoint**

Do not commit if the user did not request commits. Record changed files and command output in the final implementation summary.

---

## Task 2: Duplicate `season_code` Guard

**Files:**
- Create: `app/supabase/migrations/20260616_unique_seasons_season_code.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add failing rule-regression assertions**

In `app/scripts/rule-regression-tests.cjs`, near the Supabase schema assertions, add:

```js
  assert(
    supabaseSchemaSource.includes('create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code)') &&
      fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260616_unique_seasons_season_code.sql'), 'utf8')
        .includes('create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code)') &&
      supabaseStoreSource.includes('Duplicate season_code detected'),
    'Season code must be unique and duplicate lookup errors must be surfaced clearly'
  );
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
cd app
npm run test:rules
```

Expected: FAIL with `Season code must be unique and duplicate lookup errors must be surfaced clearly`.

- [ ] **Step 3: Create the fail-closed migration**

Create `app/supabase/migrations/20260616_unique_seasons_season_code.sql`:

```sql
do $$
begin
  if exists (
    select 1
    from public.seasons
    where season_code is not null and btrim(season_code) <> ''
    group by season_code
    having count(*) > 1
  ) then
    raise exception 'Cannot add unique seasons.season_code constraint: duplicate season_code rows exist.';
  end if;
end $$;

create unique index if not exists seasons_season_code_unique_idx
  on public.seasons (season_code);
```

- [ ] **Step 4: Update clean-start schema**

In `app/supabase/schema.sql`, near the existing `seasons_season_code_idx`, keep the non-unique index if it is still useful for migration compatibility and add:

```sql
create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code);
```

- [ ] **Step 5: Improve duplicate lookup error**

In `app/src/lib/supabaseStore.ts`, replace `findSeasonByCode` with:

```ts
async findSeasonByCode(code: string): Promise<Season | null> {
  const result = await client().from('seasons').select('*').eq('season_code', code).maybeSingle();
  if (result.error) {
    const message = result.error.message ?? '';
    if (/multiple|Results contain/i.test(message)) {
      throw new Error(`find season: Duplicate season_code detected for ${code}. Resolve duplicate seasons before importing.`);
    }
    throw new Error(`find season: ${message}`);
  }
  const row = result.data as SeasonRelationalRow | null;
  return row ? fromSeasonRow(row) : null;
},
```

- [ ] **Step 6: Verify Task 2**

Run:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
```

Expected: both commands pass.

---

## Task 3: Contract Documentation

**Files:**
- Modify: `context.md`
- Modify: `architecture.md`

- [ ] **Step 1: Add concise context wording**

In `context.md`, near the existing import/server-first section, add:

```md
- `seasons.season_code` is the unique business key for import lookup; `seasons.id` remains the generated primary key and the user-facing operational boundary.
- No-schema season hardening scopes destructive remote modification deletes to `season_id` where the table already carries `season_id`. Counters/windows remain global-keyed until the composite-PK migration adds `season_id` to those child tables.
- Remote composite keys `(season_id, record_id)` and `(season_id, leg_id)` are the target schema for flight records, modifications, and their child tables, but that migration must be shipped separately from the no-schema safety pass.
```

- [ ] **Step 2: Add architecture note**

In `architecture.md`, add a compact note near the Supabase storage section:

```md
Season ownership hardening is staged. The current safe pass scopes destructive modification deletes and enforces unique `season_code`; the larger remote composite-key migration is deferred because it changes parent/child table keys, mappers, RPCs, and reporting surfaces together.
```

- [ ] **Step 3: Scan for mojibake**

Run:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$markers = @([char]0x00C3, [char]0x00C2, ([string][char]0x00E1 + [char]0x00BA), [char]0x00C6, [char]0x00C4, [char]0xFFFD)
$pattern = ($markers | ForEach-Object { [regex]::Escape([string]$_) }) -join '|'
Select-String -Path 'context.md','architecture.md' -Pattern $pattern -Encoding UTF8
```

Expected: no output.

- [ ] **Step 4: Verify Task 3**

Run:

```powershell
cd app
npm run test:rules
```

Expected: PASS.

---

## Future Package D: Composite Remote PK Migration

This package should get its own execution branch and a dedicated plan before implementation.

Required scope:

- Add/backfill `season_id` to:
  - `season_flight_record_counters`
  - `season_flight_record_checkin_windows`
  - `season_modification_counters`
  - `season_modification_checkin_windows`
- Change parent primary keys:
  - `season_flight_records`: `(season_id, record_id)`
  - `season_modifications`: `(season_id, leg_id)`
- Change child primary keys and foreign keys:
  - `season_flight_record_counters`: `(season_id, record_id, counter_group, item_index)`
  - `season_flight_record_checkin_windows`: `(season_id, record_id, counter_key)`
  - `season_modification_counters`: `(season_id, leg_id, counter_group, item_index)`
  - `season_modification_checkin_windows`: `(season_id, leg_id, counter_key)`
  - `season_modification_added_legs`: `(season_id, leg_id)` and composite FK to `season_modifications`
- Update `app/src/lib/supabaseRelationalMappers.ts` row types and mapper outputs to include `season_id` for child rows.
- Update `app/src/lib/supabaseStore.ts` readers/writers to pass `seasonId` into child-row mappers and scoped readers.
- Update `get_season_workspace_snapshot`, `upsert_season_flight_record_from_json`, `upsert_season_modification_from_json`, cleanup RPCs, reporting views/RPCs, and Edge Functions that assume global `record_id` or `leg_id`.
- Update `app/scripts/rule-regression-tests.cjs` oracle that currently asserts `record_id text primary key`, `leg_id text primary key`, and “global record keys”.

Minimum verification:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
```

Run Supabase migration verification in the project’s normal linked environment only after reviewing duplicate/key backfill results.

---

## Future Package E: Local Mirror Recovery UX

This package should remain separate from Package A/B because it changes user-visible import recovery behavior.

Recommended shape:

- Add a local UI/import state that records Point L failure: remote commit completed, local mirror failed.
- Add a visible `Re-sync local mirror` action in `SeasonalSchedulePage.tsx`.
- Rebuild the local mirror by loading the committed remote state and calling `importNativeSeasonSnapshot`.
- Do not claim this fixes F-4/F-6 partial remote writes.

Minimum verification:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
```

---

## Future Package F: Remote Import Transaction

This is the real F-4/F-6 fix and should be planned after Package A/B unless Point R failures are already observed.

Recommended shape:

- Add a Supabase RPC such as `apply_seasonal_import_remote(...)`.
- Move `clearSourceRows`, `deleteModifications`, `updateSeason`/`createSeason`, and `batchWriteFlightRecords` semantics into one database transaction.
- Keep `importNativeSeasonSnapshot` as the local mirror step after the remote transaction commits.
- Add tests that force a failure inside the remote transaction and prove no partial remote import remains.

Minimum verification:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
```

---

## Final Verification for Package A/B/C

Run after Tasks 1-3:

```powershell
cd app
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
```

Optional native regression if import mirror code is touched accidentally:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup
```

Do not run `npm run native:build` for Package A/B/C unless the user asks for a release/package verification.

---

## Self-Review

- Spec coverage: Package A covers no-schema destructive delete safety; Package B covers unique `season_code`; Package C captures docs. Composite PK, local mirror UX, and remote transaction are explicitly deferred because they are separate blast-radius classes.
- Placeholder scan: no unresolved planning placeholders detected in executable steps.
- Type consistency: Package A does not add `season_id` to child counters/windows because those tables lack the column. Package D owns those row type and mapper changes.
