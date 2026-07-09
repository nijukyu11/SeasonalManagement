# Seasonal Server-First Issue Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed SeasonalManagement issues without reintroducing SQLite/local-store reads as the source of truth.

**Architecture:** Keep Supabase/server-first as the write and read boundary for Seasonal, Detailed, Check-in, and export flows. Fix shared server mutation routing first, then fix draft-save affordances, then repair confirmed S26 duplicate data with backup and dry-run SQL, while treating the W26 TG case as code normalization plus targeted audit because the real database did not show active TG duplicates.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node `node:test`, Supabase Postgres, Tauri runtime, existing server mutation RPC `apply_season_server_mutation_v1`.

---

## Current Findings To Preserve

- Server-first mode is active through `app/src/lib/serverAuthoritativeMode.ts` with `SERVER_AUTHORITATIVE_MODE = true`.
- Seasonal/Detailed export and schedule windows currently read through `loadSeasonWorkspaceWindow`, not SQLite, when server-first is available.
- Seasonal and Detailed draft state exists, but the shared save button only enables when `pendingCount > 0`, so draft-only changes cannot be submitted.
- Check-in drag/drop applies optimistic UI, then rolls back through `rollbackAccumulatedCheckInCommit` when the write path fails.
- The check-in write path still has local/worker fallbacks. In server-first mode those fallbacks must not be used for writes.
- W26 TG real database audit did not find active duplicate TG effective rows. The malformed pattern found was `flight_number='TGTG559'` with `raw_flight_number='TG559'`.
- S26 export duplicate is real data in Supabase, not SQLite:
  - `KC259` on `2026-06-06`
  - `KC260` on `2026-06-06`
  - `KC259` on `2026-06-07`
  - `KC260` on `2026-06-07`
  - `PR586` on `2026-06-10`
- Confirmed S26 season id: `season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6`.
- Confirmed W26 season id: `season-f77c5ea9-be54-4615-ab0a-d83062b9b854`.

---

## File Structure

### Shared Server-First Mutation Boundary

- Modify: `app/src/lib/nativeLocalSeasonStore.ts`
  - Move the `SERVER_AUTHORITATIVE_MODE` branch before `isNativeLocalStoreRuntime()` checks in mutation functions.
  - Keep Tauri/native paths only for non-server-authoritative mode.
- Modify: `app/src/lib/nativeLocalSeasonStore.source.test.ts`
  - Add source regression checks that server-first branches cannot be bypassed by missing native runtime.

### Draft Save

- Create: `app/src/app/components/syncActionButtonState.ts`
  - Pure helper for button label, title, disabled state, and submit eligibility.
- Create: `app/src/app/components/syncActionButtonState.test.ts`
  - Node tests for draft-only, pending-only, busy, and idle states.
- Modify: `app/src/app/components/SyncActionButton.tsx`
  - Accept a `draftCount` prop and use the helper.
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
  - Pass Seasonal draft count into `SyncActionButton`.
  - Keep `beforeSync: commitDraftBeforeSave`.
- Modify: `app/src/app/detailed/page.tsx`
  - Pass Detailed draft count into `SyncActionButton`.
  - Keep `beforeSync: commitDraftBeforeSave`.
- Create: `app/src/app/seasonalDetailedDraftSave.source.test.ts`
  - Source test to lock both pages to `draftCount` and `beforeSync`.

### Check-in Gantt Commit

- Create: `app/src/app/checkin/checkInCommitErrors.ts`
  - Format check-in write failures with source, leg ids, and raw error message.
- Create: `app/src/app/checkin/checkInCommitErrors.test.ts`
  - Node tests for user-visible failure messages.
- Modify: `app/src/app/checkin/page.tsx`
  - Use server-first mutation results before worker/local fallback.
  - Use the new failure formatter in rollback alerts.
- Modify: `app/src/lib/onlineFirstMode.source.test.ts`
  - Add source regression that check-in still passes source `'checkin'` to the server mutation boundary.

### W26 TG Copy / Flight Number Normalization

- Create: `app/src/lib/parser.test.ts`
  - Test raw flight numbers that already include airline prefix.
- Modify: `app/src/lib/parser.ts`
  - Normalize `cleanFlightNumber('TG', 'TG559')` to `flightNumber='TG559'`, `rawFlightNumber='559'`.
- Create: `app/src/lib/atomicSchedule.duplicate.test.ts`
  - Test duplicate validation for copying a flight number from source date to an empty target date.
- Modify: `app/src/lib/atomicSchedule.ts`
  - Only if the test exposes a code bug; otherwise leave duplicate key logic unchanged.

### S26 Export Data Repair

- Create: `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql`
  - Read-only audit query matching app duplicate key: `date|airline|flight_number`.
- Create: `docs/superpowers/artifacts/2026-07-09-s26-duplicate-repair.sql`
  - Backup, dry-run, and transaction-safe cleanup for confirmed duplicate `source_kind='added'` rows.
- Do not modify app code for S26 export unless post-repair export still fails.

### Manual Verification Notes

- Create: `docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md`
  - Record exact commands, DB query outputs, and smoke test result for each issue.

---

## Task 1: Lock Server-First Mutation Routing

**Files:**
- Modify: `app/src/lib/nativeLocalSeasonStore.ts`
- Modify: `app/src/lib/nativeLocalSeasonStore.source.test.ts`

- [ ] **Step 1: Add failing source tests for server-first branch order**

Append these tests to `app/src/lib/nativeLocalSeasonStore.source.test.ts`:

```ts
test('server-authoritative modification writes run before native runtime gating', () => {
  const functionStart = source.indexOf('export async function runNativeLocalModificationBatchDeltaResult');
  assert.notEqual(functionStart, -1, 'runNativeLocalModificationBatchDeltaResult should exist');
  const functionEnd = source.indexOf('export async function runNativeLocalModificationBatchDelta', functionStart);
  assert.notEqual(functionEnd, -1, 'next exported function should exist');
  const body = source.slice(functionStart, functionEnd);

  const serverBranch = body.indexOf('if (SERVER_AUTHORITATIVE_MODE)');
  const nativeGate = body.indexOf('if (!isNativeLocalStoreRuntime()) return null');

  assert.notEqual(serverBranch, -1, 'server-authoritative branch should exist');
  assert.notEqual(nativeGate, -1, 'native runtime gate should exist for offline mode');
  assert.ok(serverBranch < nativeGate, 'server-authoritative branch must run before native runtime gating');
});

test('server-authoritative schedule writes run before native runtime gating', () => {
  const functionStart = source.indexOf('export async function runNativeScheduleMutation');
  assert.notEqual(functionStart, -1, 'runNativeScheduleMutation should exist');
  const body = source.slice(functionStart);

  const serverBranch = body.indexOf('if (SERVER_AUTHORITATIVE_MODE)');
  const nativeGate = body.indexOf('if (!isNativeLocalStoreRuntime()) return null');

  assert.notEqual(serverBranch, -1, 'server-authoritative branch should exist');
  assert.notEqual(nativeGate, -1, 'native runtime gate should exist for offline mode');
  assert.ok(serverBranch < nativeGate, 'server-authoritative branch must run before native runtime gating');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/nativeLocalSeasonStore.source.test.ts
```

Expected: FAIL because `if (!isNativeLocalStoreRuntime()) return null` currently appears before the server-first branch.

- [ ] **Step 3: Move server-first branches before native gating**

In `app/src/lib/nativeLocalSeasonStore.ts`, change `runNativeLocalModificationBatchDeltaResult` to this structure:

```ts
export async function runNativeLocalModificationBatchDeltaResult(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>,
  source: NativeLocalModificationSource = 'allocation'
): Promise<NativeLocalModificationBatchDeltaResult | null> {
  if (SERVER_AUTHORITATIVE_MODE) {
    const operations = [
      ...mods.map((mod) => ({ type: 'modification', mod })),
      ...historyOperation(history),
    ];
    const syncMeta = await applyServerAuthoritativeOperations(seasonId, source, operations);
    return {
      syncMeta,
      affectedIds: mods.map((mod) => mod.legId),
    };
  }

  if (!isNativeLocalStoreRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeLocalModificationBatchDeltaResult>('apply_local_modification_batch_delta', {
    input: {
      seasonId,
      mods,
      history,
    },
  });
}
```

Change `runNativeScheduleMutation` to this structure:

```ts
export async function runNativeScheduleMutation(
  seasonId: string,
  records: FlightRecord[],
  deletedIds: string[] = [],
  mods: FlightModification[] = [],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>,
  sourceRows: ParsedRow[] = []
): Promise<LocalSyncMeta | null> {
  if (SERVER_AUTHORITATIVE_MODE) {
    const operations = [
      ...records.map((record) => ({ type: 'flightRecord', record })),
      ...deletedIds.map((id) => ({ type: 'flightRecord', record: { id, status: 'deleted' } })),
      ...sourceRows.map((row) => ({ type: 'sourceRow', row })),
      ...mods.map((mod) => ({ type: 'modification', mod })),
      ...historyOperation(history),
    ];
    return applyServerAuthoritativeOperations(seasonId, 'schedule', operations);
  }

  if (!isNativeLocalStoreRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<NativeScheduleMutationResult>('apply_schedule_mutation', {
    input: {
      seasonId,
      records,
      sourceRows,
      mods,
      deletedIds,
      history,
    },
  });
  return result.syncMeta;
}
```

- [ ] **Step 4: Run source regression tests**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/nativeLocalSeasonStore.source.test.ts
node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```powershell
git add app/src/lib/nativeLocalSeasonStore.ts app/src/lib/nativeLocalSeasonStore.source.test.ts
git commit -m "fix: route server-first schedule mutations before native fallback"
```

---

## Task 2: Enable Draft-Only Save Button State

**Files:**
- Create: `app/src/app/components/syncActionButtonState.ts`
- Create: `app/src/app/components/syncActionButtonState.test.ts`
- Modify: `app/src/app/components/SyncActionButton.tsx`

- [ ] **Step 1: Add tests for sync button state**

Create `app/src/app/components/syncActionButtonState.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getSyncActionButtonState } from './syncActionButtonState.ts';

test('draft-only changes can be submitted', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 0,
    draftCount: 2,
    progress: null,
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, false);
  assert.equal(state.label, 'Save draft');
  assert.equal(state.title, 'Save draft changes to server');
});

test('pending server changes keep existing save label', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 3,
    draftCount: 0,
    progress: 'Submitting 3 pending submit',
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, false);
  assert.equal(state.label, 'Save pending');
  assert.equal(state.title, 'Submitting 3 pending submit');
});

test('busy state blocks submit and keeps progress title', () => {
  const state = getSyncActionButtonState({
    syncing: true,
    pendingCount: 0,
    draftCount: 1,
    progress: 'Submitting draft',
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, true);
  assert.equal(state.label, 'Submitting...');
  assert.equal(state.title, 'Submitting draft');
});

test('idle state remains disabled', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 0,
    draftCount: 0,
    progress: null,
  });

  assert.equal(state.canSubmit, false);
  assert.equal(state.disabled, true);
  assert.equal(state.label, 'No pending');
  assert.equal(state.title, 'No pending changes to submit');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts
```

Expected: FAIL because `syncActionButtonState.ts` does not exist.

- [ ] **Step 3: Implement button state helper**

Create `app/src/app/components/syncActionButtonState.ts`:

```ts
export interface SyncActionButtonStateInput {
  syncing: boolean;
  pendingCount: number;
  draftCount?: number;
  progress?: string | null;
}

export interface SyncActionButtonState {
  canSubmit: boolean;
  disabled: boolean;
  busy: boolean;
  label: string;
  title: string;
  disabledCursorClass: string;
}

export function getSyncActionButtonState(input: SyncActionButtonStateInput): SyncActionButtonState {
  const draftCount = input.draftCount ?? 0;
  const hasPending = input.pendingCount > 0;
  const hasDraft = draftCount > 0;
  const canSubmit = hasPending || hasDraft;
  const busy = input.syncing;
  const label = busy
    ? 'Submitting...'
    : hasPending
      ? 'Save pending'
      : hasDraft
        ? 'Save draft'
        : 'No pending';
  const title = busy
    ? input.progress ?? 'Submitting pending changes'
    : hasPending
      ? input.progress ?? 'Submit pending changes to server'
      : hasDraft
        ? 'Save draft changes to server'
        : 'No pending changes to submit';

  return {
    canSubmit,
    disabled: busy || !canSubmit,
    busy,
    label,
    title,
    disabledCursorClass: busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed',
  };
}
```

- [ ] **Step 4: Update SyncActionButton to use helper**

Modify `app/src/app/components/SyncActionButton.tsx`:

```ts
import { getSyncActionButtonState } from './syncActionButtonState';

interface SyncActionButtonProps {
  syncing: boolean;
  pendingCount: number;
  draftCount?: number;
  progress?: string | null;
  onSync: () => Promise<void> | void;
  className?: string;
}
```

Inside the component, replace local `hasPending`, `busy`, `disabledCursorClass`, and `label` calculations with:

```ts
  const buttonState = getSyncActionButtonState({
    syncing: syncing || clickLocked,
    pendingCount,
    draftCount,
    progress,
  });
```

Update the click guard:

```ts
    if (buttonState.disabled || !buttonState.canSubmit || clickLockedRef.current) return;
```

Update the button props:

```tsx
      disabled={buttonState.disabled}
      aria-busy={buttonState.busy ? 'true' : 'false'}
      title={buttonState.title}
      className={`flex min-w-[116px] items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container ${buttonState.disabledCursorClass} disabled:opacity-70 ${className}`}
```

Update the icon and label:

```tsx
      <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${buttonState.busy ? 'animate-spin' : ''}`}>sync</span>
      <span>{buttonState.label}</span>
```

- [ ] **Step 5: Run helper test**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```powershell
git add app/src/app/components/SyncActionButton.tsx app/src/app/components/syncActionButtonState.ts app/src/app/components/syncActionButtonState.test.ts
git commit -m "fix: enable sync action for draft-only changes"
```

---

## Task 3: Wire Seasonal And Detailed Draft Counts Into Save

**Files:**
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Create: `app/src/app/seasonalDetailedDraftSave.source.test.ts`

- [ ] **Step 1: Add source test for both draft save surfaces**

Create `app/src/app/seasonalDetailedDraftSave.source.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const seasonalSource = readFileSync(join(process.cwd(), 'src/app/SeasonalSchedulePage.tsx'), 'utf8');
const detailedSource = readFileSync(join(process.cwd(), 'src/app/detailed/page.tsx'), 'utf8');

test('seasonal schedule passes draft count to sync action and commits draft before sync', () => {
  assert.match(seasonalSource, /const draftChangeCount = \(\(draftState\?\.records\.length \?\? 0\) \+ \(draftState\?\.modifications\.length \?\? 0\)\)/);
  assert.match(seasonalSource, /<SyncActionButton[\s\S]*draftCount=\{draftChangeCount\}[\s\S]*onSync=\{handleSync\}/);
  assert.match(seasonalSource, /beforeSync:\s*commitDraftBeforeSave/);
});

test('detailed schedule passes draft count to sync action and commits draft before sync', () => {
  assert.match(detailedSource, /const draftChangeCount = draftState\?\.modifications\.length \?\? 0/);
  assert.match(detailedSource, /<SyncActionButton[\s\S]*draftCount=\{draftChangeCount\}[\s\S]*onSync=\{handleSync\}/);
  assert.match(detailedSource, /beforeSync:\s*commitDraftBeforeSave/);
});
```

- [ ] **Step 2: Run source test and verify it fails**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/seasonalDetailedDraftSave.source.test.ts
```

Expected: FAIL because neither page passes `draftCount`.

- [ ] **Step 3: Add Seasonal draft count**

In `app/src/app/SeasonalSchedulePage.tsx`, near the existing `hasDraftChanges` constant, add:

```ts
  const draftChangeCount = ((draftState?.records.length ?? 0) + (draftState?.modifications.length ?? 0));
  const hasDraftChanges = draftChangeCount > 0;
```

Replace the current `hasDraftChanges` calculation:

```ts
  const hasDraftChanges = (draftState?.records.length ?? 0) + (draftState?.modifications.length ?? 0) > 0;
```

Update `SyncActionButton`:

```tsx
              <SyncActionButton
                syncing={syncInProgress}
                pendingCount={syncPendingCount}
                draftCount={draftChangeCount}
                progress={syncProgress}
                onSync={handleSync}
              />
```

Update the draft badge count to reuse the same count:

```tsx
                {draftChangeCount} draft changes
```

- [ ] **Step 4: Add Detailed draft count**

In `app/src/app/detailed/page.tsx`, near the existing `hasDraftChanges` constant, add:

```ts
  const draftChangeCount = draftState?.modifications.length ?? 0;
  const hasDraftChanges = draftChangeCount > 0;
```

Replace the current `hasDraftChanges` calculation:

```ts
  const hasDraftChanges = (draftState?.modifications.length ?? 0) > 0;
```

Update `SyncActionButton`:

```tsx
              <SyncActionButton
                syncing={syncInProgress}
                pendingCount={syncPendingCount}
                draftCount={draftChangeCount}
                progress={syncProgress}
                onSync={handleSync}
              />
```

Update the draft badge count:

```tsx
              <span className="text-xs font-semibold">{draftChangeCount} draft changes</span>
```

- [ ] **Step 5: Run draft save source test and helper test**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/seasonalDetailedDraftSave.source.test.ts
node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts
```

Expected: PASS.

- [ ] **Step 6: Manual draft save smoke**

Run the app:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
npm run dev
```

Manual checks:

1. Open Seasonal Schedule.
2. Make one draft-only edit.
3. Confirm button label is `Save draft`.
4. Click save.
5. Reload the route.
6. Confirm the edit is still present from Supabase-backed state.
7. Repeat the same sequence in Detailed Schedule.

- [ ] **Step 7: Commit checkpoint**

```powershell
git add app/src/app/SeasonalSchedulePage.tsx app/src/app/detailed/page.tsx app/src/app/seasonalDetailedDraftSave.source.test.ts
git commit -m "fix: wire seasonal and detailed drafts into save action"
```

---

## Task 4: Prevent Check-in Server-First Writes From Falling Back To Local Worker

**Files:**
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/lib/onlineFirstMode.source.test.ts`

- [ ] **Step 1: Add source regression for check-in server-first source**

Append to `app/src/lib/onlineFirstMode.source.test.ts`:

```ts
test('check-in writes use the server-first mutation source before worker fallback', () => {
  const checkInSource = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
  const nativeCommitIndex = checkInSource.indexOf('const nativeResult = await commitCheckInModificationsNative');
  const workerIndex = checkInSource.indexOf('const worker = getCheckInCommitWorker()');

  assert.notEqual(nativeCommitIndex, -1, 'check-in should try shared mutation boundary first');
  assert.notEqual(workerIndex, -1, 'worker fallback should still exist for non-server local mode');
  assert.ok(nativeCommitIndex < workerIndex, 'server mutation boundary should run before worker fallback');
  assert.match(checkInSource, /runNativeLocalModificationBatchDeltaResult\(seasonId,\s*mods,[\s\S]*?,\s*'checkin'\s*\)/);
});
```

- [ ] **Step 2: Run source test**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts
```

Expected after Task 1: PASS. If it fails, fix the ordering in `persistCheckInModifications` so `commitCheckInModificationsNative` remains before worker fallback.

- [ ] **Step 3: Harden null result handling in check-in flush**

In `app/src/app/checkin/page.tsx`, update `flushAccumulatedCheckInCommit` after the persist call:

```ts
      const result = await persistCheckInModifications(season.id, entry.mods, entry.description);
      if (!result.syncMeta) {
        throw new Error('Check-in server mutation completed without sync metadata.');
      }
```

This prevents silent return after a write path that did not actually persist.

- [ ] **Step 4: Run check-in source and workspace tests**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```powershell
git add app/src/app/checkin/page.tsx app/src/lib/onlineFirstMode.source.test.ts
git commit -m "fix: keep check-in writes on server-first mutation path"
```

---

## Task 5: Surface Check-in Commit Failures With Useful Diagnostics

**Files:**
- Create: `app/src/app/checkin/checkInCommitErrors.ts`
- Create: `app/src/app/checkin/checkInCommitErrors.test.ts`
- Modify: `app/src/app/checkin/page.tsx`

- [ ] **Step 1: Add tests for check-in error formatting**

Create `app/src/app/checkin/checkInCommitErrors.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCheckInCommitFailure } from './checkInCommitErrors.ts';

test('formats Error objects with source and leg ids', () => {
  const message = formatCheckInCommitFailure({
    error: new Error('apply season server mutation: permission denied'),
    description: 'Allocated TG559 to counter 21',
    legIds: ['leg-1'],
    source: 'checkin',
  });

  assert.equal(
    message,
    'Allocated TG559 to counter 21 failed through checkin for leg-1: apply season server mutation: permission denied'
  );
});

test('formats non-Error values without losing raw message', () => {
  const message = formatCheckInCommitFailure({
    error: 'network timeout',
    description: 'Moved TG559 check-in allocation',
    legIds: ['leg-1', 'leg-2'],
    source: 'checkin-worker',
  });

  assert.equal(
    message,
    'Moved TG559 check-in allocation failed through checkin-worker for leg-1, leg-2: network timeout'
  );
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/checkin/checkInCommitErrors.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement error formatter**

Create `app/src/app/checkin/checkInCommitErrors.ts`:

```ts
export interface CheckInCommitFailureInput {
  error: unknown;
  description: string;
  legIds: string[];
  source: string;
}

export function formatCheckInCommitFailure(input: CheckInCommitFailureInput): string {
  const rawMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const legSummary = input.legIds.length > 0 ? input.legIds.join(', ') : 'unknown leg';
  return `${input.description} failed through ${input.source} for ${legSummary}: ${rawMessage}`;
}
```

- [ ] **Step 4: Use formatter in rollback alert**

In `app/src/app/checkin/page.tsx`, import:

```ts
import { formatCheckInCommitFailure } from './checkInCommitErrors';
```

In `rollbackAccumulatedCheckInCommit`, replace alert message:

```ts
      message: formatCheckInCommitFailure({
        error,
        description: entry.description,
        legIds: entry.legIds,
        source: 'checkin',
      }),
```

- [ ] **Step 5: Run tests**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/app/checkin/checkInCommitErrors.test.ts
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: PASS.

- [ ] **Step 6: Manual check-in smoke on a fresh install profile**

Run the same app build/profile that reproduces the issue:

1. Open Check-in Gantt.
2. Drag an unallocated flight to a counter.
3. Wait for the commit debounce to flush.
4. Confirm the bar does not jump back.
5. Reload the route.
6. Confirm the counter assignment remains.
7. If it still rolls back, capture the exact `Check-in Update Failed` message and inspect Supabase/Kong/PostgREST logs for the same timestamp.

- [ ] **Step 7: Commit checkpoint**

```powershell
git add app/src/app/checkin/page.tsx app/src/app/checkin/checkInCommitErrors.ts app/src/app/checkin/checkInCommitErrors.test.ts
git commit -m "fix: show check-in server commit failure details"
```

---

## Task 6: Normalize Already-Prefixed Flight Numbers For W26 TG

**Files:**
- Create: `app/src/lib/parser.test.ts`
- Create: `app/src/lib/atomicSchedule.duplicate.test.ts`
- Modify: `app/src/lib/parser.ts`
- Modify: `app/src/lib/atomicSchedule.ts` only if the duplicate test fails after parser fix.

- [ ] **Step 1: Add parser tests for already-prefixed raw numbers**

Create `app/src/lib/parser.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanFlightNumber } from './parser.ts';

test('cleanFlightNumber does not double-prefix raw values that already include airline', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559'), {
    flightNumber: 'TG559',
    rawFlightNumber: '559',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber keeps suffixes after removing existing airline prefix', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559A'), {
    flightNumber: 'TG559A',
    rawFlightNumber: '559A',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber still pads numeric values', () => {
  assert.deepEqual(cleanFlightNumber('TG', '59'), {
    flightNumber: 'TG059',
    rawFlightNumber: '059',
    requestStatusCode: null,
  });
});
```

- [ ] **Step 2: Add duplicate validation test for copy-to-empty-date**

Create `app/src/lib/atomicSchedule.duplicate.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNoDuplicateFlightNumbersForEffectiveRecords } from './atomicSchedule.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg>): FlightLeg {
  const date = overrides.date ?? '2026-11-01';
  return {
    id: overrides.id ?? `leg-${date}`,
    linkId: overrides.linkId ?? `link-${date}`,
    type: overrides.type ?? 'D',
    airline: overrides.airline ?? 'TG',
    flightNumber: overrides.flightNumber ?? 'TG559',
    rawFlightNumber: overrides.rawFlightNumber ?? '559',
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'BKK',
    schedule: overrides.schedule ?? '10:30',
    aircraft: overrides.aircraft ?? '333',
    category: overrides.category ?? 'PAX',
    flightType: overrides.flightType ?? 'PAX',
    codeShares: overrides.codeShares ?? null,
    intDomInd: overrides.intDomInd ?? 'J',
    pax: overrides.pax ?? null,
    gate: overrides.gate ?? null,
    stand: overrides.stand ?? null,
    counter: overrides.counter ?? null,
    carousel: overrides.carousel ?? null,
    mct: overrides.mct ?? null,
    fb: overrides.fb ?? null,
    lb: overrides.lb ?? null,
    bhs: overrides.bhs ?? null,
    ghs: overrides.ghs ?? null,
    date,
    scheduledDate: overrides.scheduledDate ?? date,
    scheduledTime: overrides.scheduledTime ?? '10:30',
    operationalDate: overrides.operationalDate ?? date,
    iataSeasonCode: overrides.iataSeasonCode ?? 'W26',
    flightSeriesId: overrides.flightSeriesId,
    dayOfWeek: overrides.dayOfWeek ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? -1,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
    sourceKind: overrides.sourceKind ?? 'added',
    sourceSide: overrides.sourceSide ?? 'DEP',
    status: overrides.status ?? 'active',
    turnaroundId: overrides.turnaroundId,
  };
}

test('duplicate validation allows copying same flight number to an empty target date', () => {
  const source = leg({ id: 'source-tg559', date: '2026-11-01' });
  const copied = leg({ id: 'copy-tg559', date: '2026-11-02', action: 'added' });

  assert.doesNotThrow(() => {
    assertNoDuplicateFlightNumbersForEffectiveRecords(
      [source],
      new Map(),
      [copied],
      [{ legId: copied.id, action: 'added' }]
    );
  });
});
```

- [ ] **Step 3: Run tests and verify parser test fails**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/parser.test.ts
node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts
```

Expected: parser test FAILS with current `TGTG559` behavior. Duplicate copy-to-empty-date test should PASS unless the current copy path is adding stale date metadata.

- [ ] **Step 4: Fix `cleanFlightNumber`**

In `app/src/lib/parser.ts`, replace the normalization block with:

```ts
  const rawWithoutAirline =
    normalizedAirline &&
    rawStr.length > normalizedAirline.length &&
    rawStr.startsWith(normalizedAirline)
      ? rawStr.slice(normalizedAirline.length)
      : rawStr;
  if (!rawWithoutAirline) return null;

  const normalizedFlight = /^\d+$/.test(rawWithoutAirline)
    ? rawWithoutAirline.padStart(3, '0')
    : rawWithoutAirline;
```

Return:

```ts
    flightNumber: `${normalizedAirline}${normalizedFlight}`,
    rawFlightNumber: normalizedFlight,
```

- [ ] **Step 5: Run parser and duplicate tests**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/parser.test.ts
node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts
node --experimental-strip-types --test src/lib/detailedScheduleState.test.ts
```

Expected: PASS.

- [ ] **Step 6: W26 TG DB audit before any data change**

Run this read-only SQL on the real Supabase database:

```sql
select
  record_id,
  date,
  operational_date,
  airline,
  flight_number,
  raw_flight_number,
  source_kind,
  status
from public.season_flight_records
where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
  and airline = 'TG'
  and status = 'active'
  and (
    flight_number like 'TGTG%'
    or raw_flight_number like 'TG%'
  )
order by operational_date, flight_number, record_id;
```

Expected from prior audit: two malformed `TGTG559` rows. Do not update them in this task unless the user approves data repair.

- [ ] **Step 7: Commit checkpoint**

```powershell
git add app/src/lib/parser.ts app/src/lib/parser.test.ts app/src/lib/atomicSchedule.duplicate.test.ts
git commit -m "fix: normalize already-prefixed flight numbers"
```

---

## Task 7: Create S26 Duplicate Audit SQL

**Files:**
- Create: `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql`

- [ ] **Step 1: Create artifact directory**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement
New-Item -ItemType Directory -Force docs\superpowers\artifacts
```

- [ ] **Step 2: Create audit SQL file**

Create `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql`:

```sql
\set s26_season_id 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'

with active_base as (
  select
    r.record_id,
    r.date,
    r.operational_date,
    r.airline,
    r.flight_number,
    r.raw_flight_number,
    r.source_kind,
    r.source_row_index,
    r.status
  from public.season_flight_records r
  where r.season_id = :'s26_season_id'
    and r.status = 'active'
    and not exists (
      select 1
      from public.season_modifications m
      where m.season_id = r.season_id
        and m.leg_id = r.record_id
        and m.action = 'deleted'
    )
),
duplicate_groups as (
  select
    date,
    airline,
    flight_number,
    count(*) as duplicate_count,
    array_agg(record_id order by record_id) as record_ids
  from active_base
  group by date, airline, flight_number
  having count(*) > 1
)
select
  g.date,
  g.airline,
  g.flight_number,
  g.duplicate_count,
  g.record_ids,
  jsonb_agg(to_jsonb(b) order by b.record_id) as rows
from duplicate_groups g
join active_base b
  on b.date = g.date
 and b.airline = g.airline
 and b.flight_number = g.flight_number
group by g.date, g.airline, g.flight_number, g.duplicate_count, g.record_ids
order by g.date, g.airline, g.flight_number;
```

- [ ] **Step 3: Run audit on server and save output in verification notes**

Run through SSH with the existing ops account. Do not write the password into the repo or the plan execution log.

```powershell
ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U postgres -d postgres" < docs\superpowers\artifacts\2026-07-09-s26-duplicate-audit.sql
```

Expected duplicate groups:

- `KC259` on `2026-06-06`
- `KC260` on `2026-06-06`
- `KC259` on `2026-06-07`
- `KC260` on `2026-06-07`
- `PR586` on `2026-06-10`

- [ ] **Step 4: Commit checkpoint**

```powershell
git add docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql
git commit -m "chore: add S26 duplicate audit query"
```

---

## Task 8: Create And Execute S26 Duplicate Repair With Backup

**Files:**
- Create: `docs/superpowers/artifacts/2026-07-09-s26-duplicate-repair.sql`
- Modify: `docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md`

- [ ] **Step 1: Create repair SQL file**

Create `docs/superpowers/artifacts/2026-07-09-s26-duplicate-repair.sql`:

```sql
\set s26_season_id 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'

begin;

create schema if not exists maintenance;

create table if not exists maintenance.s26_duplicate_flight_records_backup_20260709
as
select
  now() as backed_up_at,
  r.*
from public.season_flight_records r
where false;

with rows_to_delete(record_id) as (
  values
    ('F_NEW_1780654155050_bl6lzj_1'),
    ('F_NEW_1780654155050_bl6lzj_2'),
    ('F_NEW_1780654155050_bl6lzj_4'),
    ('F_NEW_1780654155050_bl6lzj_5'),
    ('F_NEW_1780654322186_li75di_1'),
    ('F_NEW_1780654322186_li75di_2'),
    ('F_NEW_1780654322186_li75di_4'),
    ('F_NEW_1780654322186_li75di_5'),
    ('F_NEW_1780796888039_giomqg_2')
),
backup_insert as (
  insert into maintenance.s26_duplicate_flight_records_backup_20260709
  select
    now() as backed_up_at,
    r.*
  from public.season_flight_records r
  join rows_to_delete d on d.record_id = r.record_id
  where r.season_id = :'s26_season_id'
  on conflict do nothing
  returning record_id
),
deleted_counters as (
  delete from public.season_flight_record_counters c
  using rows_to_delete d
  where c.record_id = d.record_id
  returning c.record_id
),
deleted_windows as (
  delete from public.season_flight_record_checkin_windows w
  using rows_to_delete d
  where w.record_id = d.record_id
  returning w.record_id
),
deleted_records as (
  delete from public.season_flight_records r
  using rows_to_delete d
  where r.season_id = :'s26_season_id'
    and r.record_id = d.record_id
    and r.source_kind = 'added'
  returning r.record_id
)
select
  (select count(*) from backup_insert) as backed_up_records,
  (select count(*) from deleted_counters) as deleted_counter_rows,
  (select count(*) from deleted_windows) as deleted_window_rows,
  (select count(*) from deleted_records) as deleted_records;

with active_base as (
  select r.record_id, r.date, r.airline, r.flight_number
  from public.season_flight_records r
  where r.season_id = :'s26_season_id'
    and r.status = 'active'
    and not exists (
      select 1
      from public.season_modifications m
      where m.season_id = r.season_id
        and m.leg_id = r.record_id
        and m.action = 'deleted'
    )
),
duplicate_groups as (
  select date, airline, flight_number, count(*) as duplicate_count, array_agg(record_id order by record_id) as record_ids
  from active_base
  group by date, airline, flight_number
  having count(*) > 1
)
select *
from duplicate_groups
order by date, airline, flight_number;

commit;
```

- [ ] **Step 2: Dry-run the repair inside a rollback wrapper**

Create a temporary local file outside git:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement
$repair = Get-Content -Raw -Encoding UTF8 docs\superpowers\artifacts\2026-07-09-s26-duplicate-repair.sql
$dryRun = $repair -replace 'commit;', 'rollback;'
Set-Content -Encoding UTF8 .\s26-duplicate-repair-dry-run.sql $dryRun
ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U postgres -d postgres" < .\s26-duplicate-repair-dry-run.sql
Remove-Item .\s26-duplicate-repair-dry-run.sql
```

Expected dry-run summary:

- `backed_up_records = 9`
- `deleted_records = 9`
- final duplicate query returns no rows for the targeted groups
- transaction rolls back

- [ ] **Step 3: Execute committed repair after dry-run is correct**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement
ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U postgres -d postgres" < docs\superpowers\artifacts\2026-07-09-s26-duplicate-repair.sql
```

Expected committed summary:

- `backed_up_records = 9`
- `deleted_records = 9`
- final duplicate query returns zero rows

- [ ] **Step 4: Re-run S26 audit**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement
ssh ops@100.91.158.79 "docker exec -i opsdata-supabase-db psql -U postgres -d postgres" < docs\superpowers\artifacts\2026-07-09-s26-duplicate-audit.sql
```

Expected: no rows.

- [ ] **Step 5: Record verification notes**

Create or append `docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md`:

```md
# 2026-07-09 Seasonal Server-First Verification

## S26 Duplicate Repair

- Season id: `season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6`
- Backup table: `maintenance.s26_duplicate_flight_records_backup_20260709`
- Dry-run result:
  - `backed_up_records = 9`
  - `deleted_records = 9`
  - duplicate query after delete returned zero rows before rollback
- Committed result:
  - `backed_up_records = 9`
  - `deleted_records = 9`
  - duplicate audit returned zero rows
```

- [ ] **Step 6: Commit checkpoint**

```powershell
git add docs/superpowers/artifacts/2026-07-09-s26-duplicate-repair.sql docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md
git commit -m "chore: add S26 duplicate repair with backup"
```

---

## Task 9: Export And End-To-End Regression

**Files:**
- Modify: `docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md`

- [ ] **Step 1: Run focused automated tests**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/nativeLocalSeasonStore.source.test.ts
node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts
node --experimental-strip-types --test src/app/seasonalDetailedDraftSave.source.test.ts
node --experimental-strip-types --test src/app/checkin/checkInCommitErrors.test.ts
node --experimental-strip-types --test src/lib/parser.test.ts
node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts
node --experimental-strip-types --test src/lib/detailedScheduleState.test.ts
node --experimental-strip-types --test src/lib/exporter.test.ts
node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run lint and build**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
npm run lint
npm run build
```

Expected: both PASS.

- [ ] **Step 3: Manual server-first smoke**

Run:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
npm run dev
```

Manual checks:

1. Seasonal Schedule draft-only edit saves and remains after reload.
2. Detailed Schedule draft-only edit saves and remains after reload.
3. Check-in Gantt drag from unallocated to a counter remains after debounce and route reload.
4. W26 TG copy to an actually empty target date does not show duplicate warning.
5. S26 export with all rows selected no longer throws `Duplicate Flight number KC259 on 2026-06-06`.

- [ ] **Step 4: Record verification notes**

Append:

```md
## Automated Tests

- `node --experimental-strip-types --test src/lib/nativeLocalSeasonStore.source.test.ts`: PASS
- `node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts`: PASS
- `node --experimental-strip-types --test src/app/seasonalDetailedDraftSave.source.test.ts`: PASS
- `node --experimental-strip-types --test src/app/checkin/checkInCommitErrors.test.ts`: PASS
- `node --experimental-strip-types --test src/lib/parser.test.ts`: PASS
- `node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts`: PASS
- `node --experimental-strip-types --test src/lib/detailedScheduleState.test.ts`: PASS
- `node --experimental-strip-types --test src/lib/exporter.test.ts`: PASS
- `node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS

## Manual Smoke

- Seasonal Schedule draft save: PASS
- Detailed Schedule draft save: PASS
- Check-in Gantt allocation save: PASS
- W26 TG copy to empty date: PASS
- S26 export all: PASS
```

- [ ] **Step 5: Commit checkpoint**

```powershell
git add docs/superpowers/artifacts/2026-07-09-seasonal-server-first-verification.md
git commit -m "docs: record seasonal server-first verification"
```

---

## Execution Order

1. Task 1 first, because it fixes the shared server-first write boundary.
2. Tasks 2 and 3 next, because they unblock draft save and depend on Task 1 for non-native server-first writes.
3. Tasks 4 and 5 next, because check-in drag/drop depends on the same write boundary and needs better error visibility.
4. Task 6 next, because W26 TG is likely normalization/repro, not database duplicate cleanup.
5. Tasks 7 and 8 after code tests, because they touch real Supabase data and require backup/dry-run.
6. Task 9 last, because export must be verified after S26 data repair.

## Stop Conditions

- Stop before executing Task 8 if the dry-run does not report exactly 9 targeted `source_kind='added'` records.
- Stop before W26 TG data repair if the audit shows only `TGTG559` malformed rows and no active duplicate groups.
- Stop if any server-first write path attempts to read or write SQLite during Seasonal, Detailed, Check-in, or export verification.
- Stop if Supabase logs show `401`, `403`, RLS denial, or RPC validation failure during check-in smoke; capture the exact message before changing more code.

## Final Verification Checklist

- [ ] No app export/detailed/check-in verification relies on SQLite as source truth.
- [ ] Seasonal draft-only save works.
- [ ] Detailed draft-only save works.
- [ ] Check-in drag/drop persists after reload.
- [ ] W26 TG copy no longer produces a false duplicate on an empty target date.
- [ ] S26 export all succeeds after duplicate data repair.
- [ ] All new tests pass.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
