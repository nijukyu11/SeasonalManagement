# Check-in Counter Management Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global check-in counter inventory, counter groups/BHS mapping, and time-bound counter locks, then enforce them in the `/checkin` Gantt.

**Architecture:** Extend global `OperationalSettings` for counter resources, groups, and locks. Keep settings persisted through `appSettings/operational`; keep flight allocation edits local-first as `FlightModification` overlays in IndexedDB and manual Sync. Put reusable counter parsing/roster/lock logic in focused library helpers and keep route files responsible for rendering and user interaction.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, Firebase Firestore, IndexedDB local workspace, existing `scripts/rule-regression-tests.cjs` regression harness.

---

## File Structure

- Modify `app/src/lib/types.ts`
  - Add `CheckInCounterResource`, `CheckInCounterGroup`, `CheckInCounterLock`, and new `OperationalSettings` arrays.
- Modify `app/src/lib/settingsRules.ts`
  - Hydrate and validate the new settings arrays.
- Create `app/src/lib/checkInCounterSettings.ts`
  - Parse counter inventory input, normalize resource labels, build resource rows, compute BHS values, and detect active locks.
- Modify `app/src/lib/checkinAllocation.ts`
  - Use configured resources for roster rows, BHS writes, group ordering, lock validation, and lock-conflict metadata.
- Modify `app/src/app/settings/page.tsx`
  - Add the `Check-in Counters` settings tab and editors.
- Modify `app/src/app/checkin/page.tsx`
  - Add the `Group by island` switch, render group sections, lock indicators, and lock-conflict bar styling.
- Modify `app/scripts/rule-regression-tests.cjs`
  - Add red/green coverage for settings validation, helper behavior, check-in allocation behavior, and source-level UI requirements.
- Modify `context.md`
  - Document the new settings and check-in behavior after implementation.

Git is unavailable on PATH in this workspace, so commit steps are intentionally replaced with verification checkpoints.

---

### Task 1: Settings Types, Hydration, And Validation

**Files:**
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/settingsRules.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write failing settings regressions**

Add imports near the current settings imports in `app/scripts/rule-regression-tests.cjs`:

```js
const {
  hydrateOperationalSettings,
  validateOperationalSettings,
} = require(path.join(tempDir, 'settingsRules.js'));
```

Extend the existing missing-settings assertion around the current `emptyOperationalSettings` check:

```js
assert(
  Array.isArray(emptyOperationalSettings.checkInCounters) &&
    emptyOperationalSettings.checkInCounters.length === 0 &&
    Array.isArray(emptyOperationalSettings.checkInCounterGroups) &&
    emptyOperationalSettings.checkInCounterGroups.length === 0 &&
    Array.isArray(emptyOperationalSettings.checkInCounterLocks) &&
    emptyOperationalSettings.checkInCounterLocks.length === 0,
  `missing check-in counter settings should hydrate to empty arrays, got ${JSON.stringify(emptyOperationalSettings)}`
);
```

Add validation failure cases:

```js
let duplicateCounterLabelError = null;
try {
  validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: 'M1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'c2', label: 'm1', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [],
    checkInCounterLocks: [],
    updatedAt: 1,
  });
} catch (err) {
  duplicateCounterLabelError = err;
}
assert(
  duplicateCounterLabelError?.message.includes('Counter labels must be unique'),
  `duplicate counter labels should be rejected, got ${duplicateCounterLabelError?.message}`
);

let duplicateGroupOwnershipError = null;
try {
  validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'g1', name: 'Island A', bhs: 'BHS-A', counterIds: ['c1'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'g2', name: 'Island B', bhs: 'BHS-B', counterIds: ['c1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [],
    updatedAt: 1,
  });
} catch (err) {
  duplicateGroupOwnershipError = err;
}
assert(
  duplicateGroupOwnershipError?.message.includes('may belong to only one counter group'),
  `duplicate counter group ownership should be rejected, got ${duplicateGroupOwnershipError?.message}`
);

let invalidLockWindowError = null;
try {
  validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [],
    checkInCounterLocks: [
      { id: 'l1', name: 'Maintenance', counterIds: ['c1'], start: '2026-05-08T09:00', end: '2026-05-08T08:00', reason: 'Work order', enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
} catch (err) {
  invalidLockWindowError = err;
}
assert(
  invalidLockWindowError?.message.includes('lock start must be before end'),
  `invalid lock windows should be rejected, got ${invalidLockWindowError?.message}`
);
```

- [ ] **Step 2: Run failing regression**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: FAIL because `checkInCounters`, `checkInCounterGroups`, and `checkInCounterLocks` are not hydrated or validated yet.

- [ ] **Step 3: Add types**

In `app/src/lib/types.ts`, add before `OperationalSettings`:

```ts
export interface CheckInCounterResource {
  id: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterGroup {
  id: string;
  name: string;
  bhs: string;
  counterIds: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterLock {
  id: string;
  name: string;
  counterIds: string[];
  start: string;
  end: string;
  reason: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

Update `OperationalSettings`:

```ts
export interface OperationalSettings {
  aircraftGroups: AircraftGroup[];
  counterAllocationRules: CounterAllocationRule[];
  checkInCounters: CheckInCounterResource[];
  checkInCounterGroups: CheckInCounterGroup[];
  checkInCounterLocks: CheckInCounterLock[];
  updatedAt: number | null;
}
```

- [ ] **Step 4: Implement hydration and validation**

In `app/src/lib/settingsRules.ts`, update imports:

```ts
import type {
  AircraftGroup,
  CheckInCounterGroup,
  CheckInCounterLock,
  CheckInCounterResource,
  CounterAllocationRule,
  CounterRuleConditions,
  FlightRecord,
  OperationalSettings,
} from './types';
```

Add helpers:

```ts
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeCounterResource(counter: Partial<CheckInCounterResource>): CheckInCounterResource {
  return {
    id: String(counter.id ?? '').trim(),
    label: normalizeName(counter.label),
    enabled: Boolean(counter.enabled),
    sortOrder: Number(counter.sortOrder ?? 0),
    createdAt: Number(counter.createdAt ?? 0),
    updatedAt: Number(counter.updatedAt ?? counter.createdAt ?? 0),
  };
}

function normalizeCounterGroup(group: Partial<CheckInCounterGroup>): CheckInCounterGroup {
  return {
    id: String(group.id ?? '').trim(),
    name: normalizeName(group.name),
    bhs: normalizeName(group.bhs),
    counterIds: normalizeUniqueIds(group.counterIds),
    sortOrder: Number(group.sortOrder ?? 0),
    createdAt: Number(group.createdAt ?? 0),
    updatedAt: Number(group.updatedAt ?? group.createdAt ?? 0),
  };
}

function normalizeCounterLock(lock: Partial<CheckInCounterLock>): CheckInCounterLock {
  return {
    id: String(lock.id ?? '').trim(),
    name: normalizeName(lock.name),
    counterIds: normalizeUniqueIds(lock.counterIds),
    start: String(lock.start ?? '').trim(),
    end: String(lock.end ?? '').trim(),
    reason: lock.reason == null ? null : normalizeName(lock.reason),
    enabled: Boolean(lock.enabled),
    createdAt: Number(lock.createdAt ?? 0),
    updatedAt: Number(lock.updatedAt ?? lock.createdAt ?? 0),
  };
}

function parseSettingsDateTime(value: string, fieldName: string): number {
  if (!LOCAL_DATETIME_PATTERN.test(value)) throw new Error(`${fieldName} must use yyyy-mm-ddTHH:mm format.`);
  const parsed = new Date(`${value}:00`).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must use yyyy-mm-ddTHH:mm format.`);
  return parsed;
}
```

In `hydrateOperationalSettings`, pass the new arrays through:

```ts
return validateOperationalSettings({
  aircraftGroups: settings?.aircraftGroups ?? [],
  counterAllocationRules: settings?.counterAllocationRules ?? [],
  checkInCounters: settings?.checkInCounters ?? [],
  checkInCounterGroups: settings?.checkInCounterGroups ?? [],
  checkInCounterLocks: settings?.checkInCounterLocks ?? [],
  updatedAt: settings?.updatedAt ?? null,
});
```

In `validateOperationalSettings`, normalize and validate counters, groups, and locks:

```ts
const counters = (settings?.checkInCounters ?? []).map((counter) => normalizeCounterResource(counter));
const counterGroups = (settings?.checkInCounterGroups ?? []).map((group) => normalizeCounterGroup(group));
const counterLocks = (settings?.checkInCounterLocks ?? []).map((lock) => normalizeCounterLock(lock));
const counterIds = new Set<string>();
const counterLabelKeys = new Set<string>();

for (const counter of counters) {
  if (!counter.id) throw new Error('Counter id is required.');
  if (!counter.label) throw new Error('Counter label is required.');
  if (counterIds.has(counter.id)) throw new Error(`Duplicate counter id ${counter.id}.`);
  counterIds.add(counter.id);
  const labelKey = counter.label.toUpperCase();
  if (counterLabelKeys.has(labelKey)) throw new Error('Counter labels must be unique.');
  counterLabelKeys.add(labelKey);
  if (!Number.isFinite(counter.sortOrder) || !Number.isFinite(counter.createdAt) || !Number.isFinite(counter.updatedAt)) {
    throw new Error(`Counter ${counter.label} numeric metadata must be finite.`);
  }
}

const counterGroupIds = new Set<string>();
const counterGroupNames = new Set<string>();
const counterGroupOwners = new Map<string, string>();
for (const group of counterGroups) {
  if (!group.id) throw new Error('Counter group id is required.');
  if (!group.name) throw new Error('Counter group name is required.');
  if (counterGroupIds.has(group.id)) throw new Error(`Duplicate counter group id ${group.id}.`);
  counterGroupIds.add(group.id);
  const nameKey = group.name.toLowerCase();
  if (counterGroupNames.has(nameKey)) throw new Error('Counter group names must be unique.');
  counterGroupNames.add(nameKey);
  for (const counterId of group.counterIds) {
    if (!counterIds.has(counterId)) throw new Error(`Counter group ${group.name} references missing counter ${counterId}.`);
    const previousOwner = counterGroupOwners.get(counterId);
    if (previousOwner && previousOwner !== group.id) throw new Error(`Counter ${counterId} may belong to only one counter group.`);
    counterGroupOwners.set(counterId, group.id);
  }
}

const lockIds = new Set<string>();
for (const lock of counterLocks) {
  if (!lock.id) throw new Error('Counter lock id is required.');
  if (!lock.name) throw new Error('Counter lock name is required.');
  if (lockIds.has(lock.id)) throw new Error(`Duplicate counter lock id ${lock.id}.`);
  lockIds.add(lock.id);
  for (const counterId of lock.counterIds) {
    if (!counterIds.has(counterId)) throw new Error(`Counter lock ${lock.name} references missing counter ${counterId}.`);
  }
  if (lock.enabled) {
    const startMs = parseSettingsDateTime(lock.start, 'Counter lock start');
    const endMs = parseSettingsDateTime(lock.end, 'Counter lock end');
    if (startMs >= endMs) throw new Error(`Counter lock ${lock.name} lock start must be before end.`);
  }
}
```

Return the new arrays:

```ts
return {
  aircraftGroups: groups,
  counterAllocationRules: rules,
  checkInCounters: counters,
  checkInCounterGroups: counterGroups,
  checkInCounterLocks: counterLocks,
  updatedAt: settings?.updatedAt == null ? null : Number(settings.updatedAt),
};
```

- [ ] **Step 5: Verify Task 1**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: PASS for the new settings validation checks.

---

### Task 2: Counter Settings Helper Module

**Files:**
- Create: `app/src/lib/checkInCounterSettings.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write failing helper regressions**

In the `require` block in `app/scripts/rule-regression-tests.cjs`, import:

```js
const {
  buildCheckInBhsValue,
  buildCheckInCounterResources,
  findCheckInLockConflict,
  parseCheckInCounterInventoryInput,
} = require(path.join(tempDir, 'checkInCounterSettings.js'));
```

Add assertions:

```js
assert(
  JSON.stringify(parseCheckInCounterInventoryInput('1-3, M1-M3, Transit').map((item) => item.label)) === JSON.stringify(['1', '2', '3', 'M1', 'M2', 'M3', 'Transit']),
  `counter inventory input should parse numeric ranges, prefixed ranges, and custom labels`
);

const counterSettings = validateOperationalSettings({
  aircraftGroups: [],
  counterAllocationRules: [],
  checkInCounters: [
    { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    { id: 'c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
    { id: 'm1', label: 'M1', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
  ],
  checkInCounterGroups: [
    { id: 'g1', name: 'Island A', bhs: 'BHS-A', counterIds: ['c1', 'c2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
    { id: 'g2', name: 'Mobility', bhs: 'BHS-M', counterIds: ['m1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
  ],
  checkInCounterLocks: [
    { id: 'l1', name: 'C2 Outage', counterIds: ['c2'], start: '2026-05-08T04:00', end: '2026-05-08T07:00', reason: 'Maintenance', enabled: true, createdAt: 1, updatedAt: 1 },
  ],
  updatedAt: 1,
});
const resourceRows = buildCheckInCounterResources({ settings: counterSettings, assignedCounters: [], groupByCounterGroup: false, visibleWindow: { start: '2026-05-08T03:00', end: '2026-05-08T08:00' } });
assert(
  JSON.stringify(resourceRows.map((row) => row.label)) === JSON.stringify(['1', '2', 'M1']) &&
    resourceRows[1].groupName === 'Island A' &&
    resourceRows[1].activeLocks.length === 1,
  `configured counter resources should preserve order, group metadata, and active locks, got ${JSON.stringify(resourceRows)}`
);
assert(
  buildCheckInBhsValue([1, 2], resourceRows) === 'BHS-A' &&
    buildCheckInBhsValue([1, 'M1'], resourceRows) === 'BHS-A,BHS-M',
  `BHS mapping should resolve one or multiple counter groups`
);
assert(
  findCheckInLockConflict([2], { start: '2026-05-08T05:00', end: '2026-05-08T06:00' }, resourceRows)?.lock.name === 'C2 Outage',
  'active lock conflicts should be detected for overlapping allocation windows'
);
```

- [ ] **Step 2: Run failing regression**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: FAIL because `checkInCounterSettings.ts` does not exist and helpers are not exported.

- [ ] **Step 3: Create helper module**

Create `app/src/lib/checkInCounterSettings.ts` with:

```ts
import type { CheckInCounterGroup, CheckInCounterLock, CheckInCounterResource, OperationalSettings } from './types';
import type { CheckInCounter, CheckInWindow } from './checkinAllocation';

export interface ParsedCheckInCounterInput {
  label: string;
}

export interface ActiveCheckInCounterLock {
  lock: CheckInCounterLock;
}

export interface CheckInCounterResourceRow {
  counter: CheckInCounter;
  counterId: string | null;
  label: string;
  enabled: boolean;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSortOrder: number | null;
  bhs: string | null;
  clusterId: string;
  clusterName: string;
  clusterBhs: string | null;
  isLegacy: boolean;
  activeLocks: ActiveCheckInCounterLock[];
}

export interface CheckInCounterResourceSection {
  id: string;
  name: string;
  bhs: string | null;
  startIndex: number;
  endIndex: number;
}

function normalizeCounterLabel(value: unknown): string {
  return String(value ?? '').trim();
}

function counterValueFromLabel(label: string): CheckInCounter {
  return /^\d+$/.test(label) ? Number(label) : label.toUpperCase();
}

function counterKey(counter: CheckInCounter): string {
  return typeof counter === 'number' ? `N:${counter}` : `S:${String(counter).toUpperCase()}`;
}

function compareCounterLabels(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  const leftMatch = /^([A-Za-z]+)(\d+)$/.exec(left);
  const rightMatch = /^([A-Za-z]+)(\d+)$/.exec(right);
  if (leftMatch && rightMatch && leftMatch[1].toUpperCase() === rightMatch[1].toUpperCase()) return Number(leftMatch[2]) - Number(rightMatch[2]);
  return left.localeCompare(right);
}

function addLabel(labels: ParsedCheckInCounterInput[], seen: Set<string>, label: string): void {
  const normalized = normalizeCounterLabel(label);
  if (!normalized) return;
  const key = normalized.toUpperCase();
  if (seen.has(key)) return;
  seen.add(key);
  labels.push({ label: normalized });
}

export function parseCheckInCounterInventoryInput(input: string): ParsedCheckInCounterInput[] {
  const labels: ParsedCheckInCounterInput[] = [];
  const seen = new Set<string>();
  for (const rawPart of input.split(/[,\s;]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const numericRange = /^(\d+)-(\d+)$/.exec(part);
    const prefixedRange = /^([A-Za-z]+)(\d+)-\1?(\d+)$/i.exec(part);
    if (numericRange) {
      const start = Number(numericRange[1]);
      const end = Number(numericRange[2]);
      const step = start <= end ? 1 : -1;
      for (let value = start; value !== end + step; value += step) addLabel(labels, seen, String(value));
    } else if (prefixedRange) {
      const prefix = prefixedRange[1].toUpperCase();
      const start = Number(prefixedRange[2]);
      const end = Number(prefixedRange[3]);
      const step = start <= end ? 1 : -1;
      for (let value = start; value !== end + step; value += step) addLabel(labels, seen, `${prefix}${value}`);
    } else {
      addLabel(labels, seen, part);
    }
  }
  return labels;
}
```

Add lock helpers and resource builder:

```ts
function parseLocalDateTime(value: string): number {
  return new Date(`${value}:00`).getTime();
}

function windowsOverlap(left: CheckInWindow, right: CheckInWindow): boolean {
  return parseLocalDateTime(left.start) < parseLocalDateTime(right.end) &&
    parseLocalDateTime(right.start) < parseLocalDateTime(left.end);
}

function activeLocksForCounter(counterId: string | null, settings: OperationalSettings, visibleWindow?: CheckInWindow): ActiveCheckInCounterLock[] {
  if (!counterId) return [];
  return settings.checkInCounterLocks
    .filter((lock) => lock.enabled && lock.counterIds.includes(counterId))
    .filter((lock) => !visibleWindow || windowsOverlap({ start: lock.start, end: lock.end }, visibleWindow))
    .map((lock) => ({ lock }));
}

export function buildCheckInCounterResources({
  settings,
  assignedCounters,
  groupByCounterGroup,
  visibleWindow,
}: {
  settings: OperationalSettings;
  assignedCounters: CheckInCounter[];
  groupByCounterGroup: boolean;
  visibleWindow?: CheckInWindow;
}): CheckInCounterResourceRow[] {
  const groupsByCounter = new Map<string, CheckInCounterGroup>();
  for (const group of settings.checkInCounterGroups) {
    for (const counterId of group.counterIds) groupsByCounter.set(counterId, group);
  }

  const rows: CheckInCounterResourceRow[] = settings.checkInCounters.map((counter) => {
    const group = groupsByCounter.get(counter.id) ?? null;
    return {
      counter: counterValueFromLabel(counter.label),
      counterId: counter.id,
      label: counter.label,
      enabled: counter.enabled,
      sortOrder: counter.sortOrder,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      groupSortOrder: group?.sortOrder ?? null,
      bhs: group?.bhs || null,
      clusterId: group?.id ?? 'ungrouped',
      clusterName: group?.name ?? 'Ungrouped',
      clusterBhs: group?.bhs || null,
      isLegacy: false,
      activeLocks: activeLocksForCounter(counter.id, settings, visibleWindow),
    };
  });

  const seen = new Set(rows.map((row) => counterKey(row.counter)));
  for (const assignedCounter of assignedCounters) {
    if (seen.has(counterKey(assignedCounter))) continue;
    rows.push({
      counter: assignedCounter,
      counterId: null,
      label: String(assignedCounter),
      enabled: true,
      sortOrder: Number.MAX_SAFE_INTEGER,
      groupId: null,
      groupName: null,
      groupSortOrder: null,
      bhs: null,
      clusterId: 'legacy',
      clusterName: 'Legacy / Unmapped',
      clusterBhs: null,
      isLegacy: true,
      activeLocks: [],
    });
    seen.add(counterKey(assignedCounter));
  }

  return rows.sort((left, right) => {
    if (groupByCounterGroup) {
      return (left.groupSortOrder ?? Number.MAX_SAFE_INTEGER) - (right.groupSortOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.clusterName.localeCompare(right.clusterName) ||
        left.sortOrder - right.sortOrder ||
        compareCounterLabels(left.label, right.label);
    }
    return left.sortOrder - right.sortOrder || compareCounterLabels(left.label, right.label);
  });
}

export function buildCheckInCounterSections(resources: CheckInCounterResourceRow[]): CheckInCounterResourceSection[] {
  const sections: CheckInCounterResourceSection[] = [];
  resources.forEach((resource, index) => {
    const last = sections[sections.length - 1];
    if (last && last.id === resource.clusterId) {
      last.endIndex = index;
    } else {
      sections.push({
        id: resource.clusterId,
        name: resource.clusterName,
        bhs: resource.clusterBhs,
        startIndex: index,
        endIndex: index,
      });
    }
  });
  return sections;
}

export function buildCheckInBhsValue(counters: CheckInCounter[], resources: CheckInCounterResourceRow[]): string | null {
  const bhsValues: string[] = [];
  for (const counter of counters) {
    const resource = resources.find((row) => counterKey(row.counter) === counterKey(counter));
    if (resource?.bhs && !bhsValues.includes(resource.bhs)) bhsValues.push(resource.bhs);
  }
  return bhsValues.length === 0 ? null : bhsValues.join(',');
}

export function findCheckInLockConflict(
  counters: CheckInCounter[],
  window: CheckInWindow,
  resources: CheckInCounterResourceRow[]
): { counter: CheckInCounter; resource: CheckInCounterResourceRow; lock: CheckInCounterLock } | null {
  for (const counter of counters) {
    const resource = resources.find((row) => counterKey(row.counter) === counterKey(counter));
    for (const activeLock of resource?.activeLocks ?? []) {
      if (windowsOverlap(window, { start: activeLock.lock.start, end: activeLock.lock.end })) {
        return { counter, resource, lock: activeLock.lock };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Verify Task 2**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: PASS for counter parsing, resource metadata, BHS mapping, and lock detection.

---

### Task 3: Check-in Allocation Domain Integration

**Files:**
- Modify: `app/src/lib/checkinAllocation.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write failing allocation regressions**

Add `buildCheckInCounterResources` to the test import from `checkInCounterSettings.js` if not already present.

Add tests around the existing check-in block:

```js
const resourceSettings = validateOperationalSettings({
  ...checkInSettings,
  checkInCounters: [
    { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    { id: 'c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
    { id: 'c3', label: '3', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
    { id: 'm1', label: 'M1', enabled: true, sortOrder: 4, createdAt: 1, updatedAt: 1 },
  ],
  checkInCounterGroups: [
    { id: 'g1', name: 'Island A', bhs: 'BHS-A', counterIds: ['c1', 'c2', 'c3'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
    { id: 'g2', name: 'Mobility', bhs: 'BHS-M', counterIds: ['m1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
  ],
  checkInCounterLocks: [
    { id: 'l1', name: 'C2 Outage', counterIds: ['c2'], start: '2026-05-08T04:00', end: '2026-05-08T07:00', reason: 'Maintenance', enabled: true, createdAt: 1, updatedAt: 1 },
  ],
});
const configuredView = buildCheckInAllocationView({
  records: [checkInRecord],
  modifications: new Map(),
  settings: resourceSettings,
  from: '2026-05-08T04:00',
  to: '2026-05-08T08:00',
  pixelsPerMinute: 4,
});
assert(
  JSON.stringify(configuredView.resources.map((row) => row.label)) === JSON.stringify(['1', '2', '3', 'M1']) &&
    JSON.stringify(configuredView.roster) === JSON.stringify([1, 2, 3, 'M1']),
  `configured settings counters should drive roster order, got ${JSON.stringify(configuredView.resources)}`
);

const bhsAllocated = allocateCheckInCounters({
  record: checkInRecord,
  records: [checkInRecord],
  modifications: new Map(),
  settings: resourceSettings,
  roster: configuredView.roster,
  resources: configuredView.resources,
  startCounter: 1,
});
assert(
  bhsAllocated.bhs === 'BHS-A' &&
    JSON.stringify(bhsAllocated.counter) === JSON.stringify([1, 2, 3]),
  `allocation should write BHS from counter group, got ${JSON.stringify(bhsAllocated)}`
);

let lockedAllocationError = null;
try {
  allocateCheckInCounters({
    record: checkInRecord,
    records: [checkInRecord],
    modifications: new Map(),
    settings: resourceSettings,
    roster: configuredView.roster,
    resources: configuredView.resources,
    startCounter: 2,
  });
} catch (err) {
  lockedAllocationError = err;
}
assert(
  lockedAllocationError?.message.includes('locked') && lockedAllocationError.message.includes('C2 Outage'),
  `allocation into active locks should be rejected, got ${lockedAllocationError?.message}`
);

const lockedExistingView = buildCheckInAllocationView({
  records: [{ ...checkInRecord, counter: [2] }],
  modifications: new Map(),
  settings: resourceSettings,
  from: '2026-05-08T04:00',
  to: '2026-05-08T08:00',
  pixelsPerMinute: 4,
});
assert(
  lockedExistingView.resourceBars[0]?.lockConflicts.length === 1,
  `existing locked allocations should remain visible and marked, got ${JSON.stringify(lockedExistingView.resourceBars)}`
);
```

- [ ] **Step 2: Run failing regression**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: FAIL because `resources`, lock metadata, BHS writes, and lock blocking are not wired into `checkinAllocation.ts`.

- [ ] **Step 3: Extend check-in view types**

In `app/src/lib/checkinAllocation.ts`, import helper types/functions:

```ts
import {
  buildCheckInBhsValue,
  buildCheckInCounterResources,
  buildCheckInCounterSections,
  findCheckInLockConflict,
  type CheckInCounterResourceRow,
  type CheckInCounterResourceSection,
} from './checkInCounterSettings';
```

Extend `CheckInResourceBar`:

```ts
  bhs: string | null;
  lockConflicts: Array<{ name: string; reason: string | null; start: string; end: string }>;
```

Extend `CheckInAllocationView`:

```ts
  resources: CheckInCounterResourceRow[];
  resourceSections: CheckInCounterResourceSection[];
```

- [ ] **Step 4: Add lock/BHS helper calls**

Add helper functions in `checkinAllocation.ts`:

```ts
function assignedCountersFromRecords(records: FlightRecord[]): CheckInCounter[] {
  const counters: CheckInCounter[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const counter of normalizeCheckInCounterList(record.counter)) addCounterUnique(counters, seen, counter);
  }
  return counters;
}

function assertNoLockConflict(
  counters: CheckInCounter[],
  window: CheckInWindow,
  resources: CheckInCounterResourceRow[] | undefined
): void {
  if (!resources) return;
  const conflict = findCheckInLockConflict(counters, window, resources);
  if (!conflict) return;
  throw new Error(`Counter ${displayCheckInCounter(conflict.counter)} is locked by ${conflict.lock.name}.`);
}

function bhsForCounters(counters: CheckInCounter[], resources: CheckInCounterResourceRow[] | undefined): string | null | undefined {
  if (!resources) return undefined;
  return buildCheckInBhsValue(counters, resources);
}
```

Update `buildCheckInAllocationView` signature:

```ts
  groupByCounterGroup?: boolean;
```

Inside `buildCheckInAllocationView`, resolve resources:

```ts
const assignedCounters = assignedCountersFromRecords(effectiveRecords);
const explicitResources = roster
  ? roster.map((counter, index) => ({
      counter,
      counterId: null,
      label: displayCheckInCounter(counter),
      enabled: true,
      sortOrder: index,
      groupId: null,
      groupName: null,
      groupSortOrder: null,
      bhs: null,
      clusterId: 'flat',
      clusterName: 'Counters',
      clusterBhs: null,
      isLegacy: false,
      activeLocks: [],
    }))
  : [];
const configuredResources = !roster && settings.checkInCounters.length > 0
  ? buildCheckInCounterResources({
      settings,
      assignedCounters,
      groupByCounterGroup: Boolean(groupByCounterGroup),
      visibleWindow: timelineWindow,
    })
  : [];
const fallbackResources = !roster && configuredResources.length === 0
  ? buildDefaultCounterRoster(effectiveRecords).map((counter, index) => ({
      counter,
      counterId: null,
      label: displayCheckInCounter(counter),
      enabled: true,
      sortOrder: index,
      groupId: null,
      groupName: null,
      groupSortOrder: null,
      bhs: null,
      clusterId: 'flat',
      clusterName: 'Counters',
      clusterBhs: null,
      isLegacy: false,
      activeLocks: [],
    }))
  : [];
const resolvedResources = explicitResources.length > 0 ? explicitResources : configuredResources.length > 0 ? configuredResources : fallbackResources;
const resolvedRoster = resolvedResources.map((resource) => resource.counter);
const resourceSections = buildCheckInCounterSections(resolvedResources);
```

When building bars, add:

```ts
const resource = resolvedResources[counterIndex];
const lockConflicts = resource?.activeLocks
  .filter((activeLock) => windowOverlaps(window, { start: activeLock.lock.start, end: activeLock.lock.end }))
  .map((activeLock) => ({
    name: activeLock.lock.name,
    reason: activeLock.lock.reason,
    start: activeLock.lock.start,
    end: activeLock.lock.end,
  })) ?? [];
```

Add `bhs` and `lockConflicts` to each resource bar.

Return:

```ts
return {
  roster: resolvedRoster,
  resources: resolvedResources,
  resourceSections,
  unallocated,
  resourceBars,
};
```

- [ ] **Step 5: Add resources parameter to mutations**

Add `resources?: CheckInCounterResourceRow[]` to:

- `allocateCheckInCounters`
- `reshapeCheckInAllocation`
- `moveCheckInAllocation`
- `addCheckInCounter`
- `resizeCheckInAllocation`
- `overrideCheckInTimes`

Before returning each modification, call:

```ts
assertNoLockConflict(counters, window, resources);
const bhs = bhsForCounters(counters, resources);
```

When building the modification patch, include:

```ts
...(bhs !== undefined ? { bhs } : {})
```

This preserves current behavior in tests and callers that do not pass resources.

- [ ] **Step 6: Verify Task 3**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: PASS for configured roster, BHS writes, lock blocking, and lock-conflict bar metadata.

---

### Task 4: Settings Page UI

**Files:**
- Modify: `app/src/app/settings/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write failing source-level UI regression**

Add to the source-level settings checks in `app/scripts/rule-regression-tests.cjs`:

```js
const settingsPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'settings', 'page.tsx'), 'utf8');
assert(
  settingsPageSource.includes(\"type SettingsTab = 'groups' | 'rules' | 'counters'\") &&
    settingsPageSource.includes('Check-in Counters') &&
    settingsPageSource.includes('Counter Inventory') &&
    settingsPageSource.includes('Counter Groups / BHS') &&
    settingsPageSource.includes('Locks / Outages') &&
    settingsPageSource.includes('parseCheckInCounterInventoryInput') &&
    settingsPageSource.includes('checkInCounters') &&
    settingsPageSource.includes('checkInCounterGroups') &&
    settingsPageSource.includes('checkInCounterLocks'),
  'Settings page must expose a Check-in Counters tab for inventory, BHS groups, and lock/outage scheduling'
);
```

- [ ] **Step 2: Run failing regression**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: FAIL because the `Check-in Counters` tab is missing.

- [ ] **Step 3: Add tab state and imports**

In `app/src/app/settings/page.tsx`, update imports:

```ts
import { parseCheckInCounterInventoryInput } from '@/lib/checkInCounterSettings';
import type { CheckInCounterGroup, CheckInCounterLock, CheckInCounterResource, CounterAllocationRule, CounterRuleConditions, OperationalSettings } from '@/lib/types';
```

Update the tab type:

```ts
type SettingsTab = 'groups' | 'rules' | 'counters';
```

Add state:

```ts
const [counterInventoryInput, setCounterInventoryInput] = useState('');
const [counterGroupName, setCounterGroupName] = useState('');
const [counterGroupBhs, setCounterGroupBhs] = useState('');
const [counterGroupCounterIds, setCounterGroupCounterIds] = useState<string[]>([]);
const [lockName, setLockName] = useState('');
const [lockCounterIds, setLockCounterIds] = useState<string[]>([]);
const [lockStart, setLockStart] = useState('');
const [lockEnd, setLockEnd] = useState('');
const [lockReason, setLockReason] = useState('');
```

- [ ] **Step 4: Add counter mutation helpers**

Add these helpers near existing `addRule` / `updateRule`:

```ts
const addCountersFromInput = () => {
  const now = currentTimestamp();
  const parsed = parseCheckInCounterInventoryInput(counterInventoryInput);
  setSettings((current) => {
    const existingLabels = new Set(current.checkInCounters.map((counter) => counter.label.toUpperCase()));
    const additions: CheckInCounterResource[] = parsed
      .filter((item) => !existingLabels.has(item.label.toUpperCase()))
      .map((item, index) => ({
        id: makeId('CHKCTR'),
        label: item.label,
        enabled: true,
        sortOrder: current.checkInCounters.length + index + 1,
        createdAt: now,
        updatedAt: now,
      }));
    return { ...current, checkInCounters: [...current.checkInCounters, ...additions], updatedAt: now };
  });
  setCounterInventoryInput('');
  setStatus('Unsaved check-in counters added');
};

const updateCounterResource = (id: string, patch: Partial<CheckInCounterResource>) => {
  const now = currentTimestamp();
  setSettings((current) => ({
    ...current,
    checkInCounters: current.checkInCounters.map((counter) => counter.id === id ? { ...counter, ...patch, updatedAt: now } : counter),
    updatedAt: now,
  }));
  setStatus('Unsaved counter inventory change');
};

const deleteCounterResource = async (id: string) => {
  const now = currentTimestamp();
  const counter = settings.checkInCounters.find((item) => item.id === id);
  const referenced = settings.checkInCounterGroups.some((group) => group.counterIds.includes(id)) ||
    settings.checkInCounterLocks.some((lock) => lock.enabled && lock.counterIds.includes(id));
  if (referenced) {
    void showAlert({ title: 'Delete Blocked', message: `${counter?.label ?? 'This counter'} is referenced by a group or active lock.`, tone: 'warning' });
    return;
  }
  const confirmed = await showConfirm({ title: 'Delete Counter', message: `Delete ${counter?.label ?? 'this counter'}?`, tone: 'warning', confirmLabel: 'Delete' });
  if (!confirmed) return;
  setSettings((current) => ({
    ...current,
    checkInCounters: current.checkInCounters.filter((item) => item.id !== id),
    checkInCounterGroups: current.checkInCounterGroups.map((group) => ({ ...group, counterIds: group.counterIds.filter((counterId) => counterId !== id), updatedAt: now })),
    updatedAt: now,
  }));
  setStatus('Unsaved counter deletion');
};

const addCounterGroup = () => {
  const now = currentTimestamp();
  setSettings((current) => ({
    ...current,
    checkInCounterGroups: [
      ...current.checkInCounterGroups,
      {
        id: makeId('CHKGRP'),
        name: counterGroupName.trim(),
        bhs: counterGroupBhs.trim(),
        counterIds: counterGroupCounterIds,
        sortOrder: current.checkInCounterGroups.length + 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }));
  setCounterGroupName('');
  setCounterGroupBhs('');
  setCounterGroupCounterIds([]);
  setStatus('Unsaved counter group added');
};

const updateCounterGroup = (id: string, patch: Partial<CheckInCounterGroup>) => {
  const now = currentTimestamp();
  setSettings((current) => ({
    ...current,
    checkInCounterGroups: current.checkInCounterGroups.map((group) => group.id === id ? { ...group, ...patch, updatedAt: now } : group),
    updatedAt: now,
  }));
  setStatus('Unsaved counter group change');
};

const deleteCounterGroup = async (id: string) => {
  const group = settings.checkInCounterGroups.find((item) => item.id === id);
  const confirmed = await showConfirm({ title: 'Delete Counter Group', message: `Delete ${group?.name ?? 'this group'}?`, tone: 'warning', confirmLabel: 'Delete' });
  if (!confirmed) return;
  setSettings((current) => ({
    ...current,
    checkInCounterGroups: current.checkInCounterGroups.filter((item) => item.id !== id),
    updatedAt: currentTimestamp(),
  }));
  setStatus('Unsaved counter group deletion');
};

const addCounterLock = () => {
  const now = currentTimestamp();
  setSettings((current) => ({
    ...current,
    checkInCounterLocks: [
      ...current.checkInCounterLocks,
      {
        id: makeId('CHKLOCK'),
        name: lockName.trim(),
        counterIds: lockCounterIds,
        start: lockStart,
        end: lockEnd,
        reason: lockReason.trim() || null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }));
  setLockName('');
  setLockCounterIds([]);
  setLockStart('');
  setLockEnd('');
  setLockReason('');
  setStatus('Unsaved counter lock added');
};

const updateCounterLock = (id: string, patch: Partial<CheckInCounterLock>) => {
  const now = currentTimestamp();
  setSettings((current) => ({
    ...current,
    checkInCounterLocks: current.checkInCounterLocks.map((lock) => lock.id === id ? { ...lock, ...patch, updatedAt: now } : lock),
    updatedAt: now,
  }));
  setStatus('Unsaved counter lock change');
};

const deleteCounterLock = async (id: string) => {
  const lock = settings.checkInCounterLocks.find((item) => item.id === id);
  const confirmed = await showConfirm({ title: 'Delete Counter Lock', message: `Delete ${lock?.name ?? 'this lock'}?`, tone: 'warning', confirmLabel: 'Delete' });
  if (!confirmed) return;
  setSettings((current) => ({
    ...current,
    checkInCounterLocks: current.checkInCounterLocks.filter((item) => item.id !== id),
    updatedAt: currentTimestamp(),
  }));
  setStatus('Unsaved counter lock deletion');
};
```

- [ ] **Step 5: Add counters tab UI**

Add a third tab button:

```tsx
<button
  type="button"
  onClick={() => setActiveTab('counters')}
  className={`px-4 py-3 text-sm font-semibold ${activeTab === 'counters' ? 'border-b-2 border-primary text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
>
  Check-in Counters
</button>
```

Render `activeTab === 'counters'` with three sections:

```tsx
{activeTab === 'counters' ? (
  <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
    <div className="space-y-5">
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Counter Inventory</h2>
        <label className="mt-4 block text-sm font-semibold text-on-surface">
          Add counters
          <input
            value={counterInventoryInput}
            onChange={(event) => setCounterInventoryInput(event.target.value)}
            placeholder="1-54, M1-M7, Transit"
            className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </label>
        <button type="button" onClick={addCountersFromInput} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add Counters
        </button>
      </div>
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Counter Groups / BHS</h2>
        <label className="mt-4 block text-sm font-semibold text-on-surface">
          Group name
          <input value={counterGroupName} onChange={(event) => setCounterGroupName(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
        </label>
        <label className="mt-3 block text-sm font-semibold text-on-surface">
          BHS
          <input value={counterGroupBhs} onChange={(event) => setCounterGroupBhs(event.target.value)} placeholder="BHS-A" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          {settings.checkInCounters.map((counter) => (
            <label key={counter.id} className="inline-flex items-center gap-2 rounded border border-outline-variant px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={counterGroupCounterIds.includes(counter.id)}
                onChange={() => setCounterGroupCounterIds((current) => current.includes(counter.id) ? current.filter((id) => id !== counter.id) : [...current, counter.id])}
              />
              {counter.label}
            </label>
          ))}
        </div>
        <button type="button" onClick={addCounterGroup} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
          <span className="material-symbols-outlined text-[18px]">hub</span>
          Add Group
        </button>
      </div>
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Locks / Outages</h2>
        <label className="mt-4 block text-sm font-semibold text-on-surface">
          Lock name
          <input value={lockName} onChange={(event) => setLockName(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold text-on-surface">
            Start
            <input type="datetime-local" value={lockStart} onChange={(event) => setLockStart(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            End
            <input type="datetime-local" value={lockEnd} onChange={(event) => setLockEnd(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
        </div>
        <label className="mt-3 block text-sm font-semibold text-on-surface">
          Reason
          <input value={lockReason} onChange={(event) => setLockReason(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          {settings.checkInCounters.map((counter) => (
            <label key={counter.id} className="inline-flex items-center gap-2 rounded border border-outline-variant px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={lockCounterIds.includes(counter.id)}
                onChange={() => setLockCounterIds((current) => current.includes(counter.id) ? current.filter((id) => id !== counter.id) : [...current, counter.id])}
              />
              {counter.label}
            </label>
          ))}
        </div>
        <button type="button" onClick={addCounterLock} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
          <span className="material-symbols-outlined text-[18px]">lock_clock</span>
          Add Lock
        </button>
      </div>
    </div>
    <div className="space-y-5">
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">Inventory Rows</h2>
        </div>
        <div className="divide-y divide-surface-variant">
          {settings.checkInCounters.map((counter) => (
            <div key={counter.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_90px_120px_auto]">
              <input value={counter.label} onChange={(event) => updateCounterResource(counter.id, { label: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <input value={String(counter.sortOrder)} onChange={(event) => updateCounterResource(counter.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={counter.enabled} onChange={(event) => updateCounterResource(counter.id, { enabled: event.target.checked })} />
                Enabled
              </label>
              <button type="button" onClick={() => void deleteCounterResource(counter.id)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700">Delete</button>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">Groups And Locks</h2>
        </div>
        <div className="divide-y divide-surface-variant">
          {settings.checkInCounterGroups.map((group) => (
            <div key={group.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_140px_1fr_auto]">
              <input value={group.name} onChange={(event) => updateCounterGroup(group.id, { name: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <input value={group.bhs} onChange={(event) => updateCounterGroup(group.id, { bhs: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <span className="text-sm text-on-surface-variant">{group.counterIds.map((id) => settings.checkInCounters.find((counter) => counter.id === id)?.label ?? id).join(', ')}</span>
              <button type="button" onClick={() => void deleteCounterGroup(group.id)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700">Delete</button>
            </div>
          ))}
          {settings.checkInCounterLocks.map((lock) => (
            <div key={lock.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_170px_170px_100px_auto]">
              <input value={lock.name} onChange={(event) => updateCounterLock(lock.id, { name: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <input type="datetime-local" value={lock.start} onChange={(event) => updateCounterLock(lock.id, { start: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <input type="datetime-local" value={lock.end} onChange={(event) => updateCounterLock(lock.id, { end: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm" />
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={lock.enabled} onChange={(event) => updateCounterLock(lock.id, { enabled: event.target.checked })} />
                Enabled
              </label>
              <button type="button" onClick={() => void deleteCounterLock(lock.id)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700">Delete</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
) : activeTab === 'groups' ? (
  currentAircraftGroupSection
) : (
  currentCounterRuleSection
)}
```

`currentAircraftGroupSection` means the existing JSX currently rendered when `activeTab === 'groups'`; move that JSX into a local `const currentAircraftGroupSection = (...)` before the return or leave it inline in the ternary. `currentCounterRuleSection` means the existing JSX currently rendered for counter allocation rules; move it into `const currentCounterRuleSection = (...)` or leave it inline.

Use compact table/list rows, checkboxes for assignment, datetime-local inputs for locks, and existing shared app dialogs for delete warnings.

- [ ] **Step 6: Verify Task 4**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npx eslint src/app/settings/page.tsx src/lib/settingsRules.ts src/lib/checkInCounterSettings.ts scripts/rule-regression-tests.cjs"
```

Expected: both commands exit 0.

---

### Task 5: Check-in Gantt UI Wiring

**Files:**
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write failing source-level Gantt regression**

Add to `checkInPageSource` assertions:

```js
assert(
  checkInPageSource.includes('groupByCounterGroup') &&
    checkInPageSource.includes('Group by island') &&
    checkInPageSource.includes('resourceSections') &&
    checkInPageSource.includes('lockConflicts') &&
    checkInPageSource.includes('LockConflict') &&
    checkInPageSource.includes('resources: allocationResult.view.resources') &&
    checkInPageSource.includes('resources={allocationResult.view.resources}'),
  'Check-in Allocation must expose group-by-island ordering, render lock conflicts, and pass resource metadata into allocation mutations'
);
```

- [ ] **Step 2: Run failing regression**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
```

Expected: FAIL because `/checkin` does not expose the group toggle or pass resource metadata.

- [ ] **Step 3: Add group toggle state**

In `app/src/app/checkin/page.tsx`, add state:

```ts
const [groupByCounterGroup, setGroupByCounterGroup] = useState(false);
```

Pass to `buildCheckInAllocationView`:

```ts
groupByCounterGroup,
```

Update the allocation memo dependency list to include `groupByCounterGroup`.

Add toolbar switch near zoom/fullscreen:

```tsx
<label className="inline-flex items-center gap-2 rounded border border-outline-variant bg-surface-container-lowest px-2 py-1 text-xs font-semibold text-on-surface">
  <input
    type="checkbox"
    checked={groupByCounterGroup}
    onChange={(event) => setGroupByCounterGroup(event.target.checked)}
  />
  Group by island
</label>
```

- [ ] **Step 4: Pass resources into mutations**

Update calls:

```ts
const mod = allocateCheckInCounters({
  record,
  records: flightRecords,
  modifications,
  settings,
  roster: allocationResult.view.roster,
  resources: allocationResult.view.resources,
  startCounter,
});
```

Apply the same `resources: allocationResult.view.resources` to move, reshape, add counter, resize, and override calls.

- [ ] **Step 5: Render resource sections and lock warnings**

Replace flat `allocationResult.view.roster.map` with a section-aware render:

```tsx
{allocationResult.view.resourceSections.map((section) => (
  <div key={section.id}>
    {groupByCounterGroup && (
      <div className="flex h-8 border-b border-surface-variant bg-surface-container">
        <div className="sticky left-0 z-20 flex items-center border-r border-surface-variant px-3 text-xs font-semibold" style={{ width: LABEL_COLUMN_WIDTH }}>
          {section.name}
        </div>
        <div className="flex items-center px-3 text-xs text-on-surface-variant" style={{ width: timeline.width }}>
          {section.bhs ? `BHS ${section.bhs}` : 'No BHS'}
        </div>
      </div>
    )}
    {allocationResult.view.resources.slice(section.startIndex, section.endIndex + 1).map((resource, offset) => {
      const rowIndex = section.startIndex + offset;
      const counter = resource.counter;
      const bars = resourceBarsByRow.get(rowIndex) ?? [];
      const isLocked = resource.activeLocks.length > 0;
      return (
        <div key={`${resource.label}-${rowIndex}`} className={`flex border-b border-surface-variant/70 ${isLocked ? 'bg-amber-50/60' : ''}`}>
          <div className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-lowest px-3 font-data-tabular text-xs font-semibold text-on-surface" style={{ width: LABEL_COLUMN_WIDTH }}>
            {isLocked && <span className="material-symbols-outlined text-[15px] text-amber-700">lock</span>}
            {resource.label}
          </div>
          <div
            className={`relative shrink-0 ${isLocked ? 'bg-amber-50/40' : ''}`}
            style={{ width: timeline.width }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setActiveDropRowIndex(rowIndex);
              applyEdgeScroll(event.clientX, event.clientY);
            }}
            onDragLeave={() => setActiveDropRowIndex((current) => current === rowIndex ? null : current)}
            onDrop={(event) => handleResourceDrop(event, rowIndex, counter)}
          >
            <TimelineGridLines ticks={timeline.ticks} />
            {bars.map(renderResourceBar)}
          </div>
        </div>
      );
    })}
  </div>
))}
```

In `renderResourceBar`, add warning styling:

```ts
const hasLockConflict = bar.lockConflicts.length > 0;
```

Use it in class/style and title:

```tsx
className={`absolute flex h-6 cursor-grab items-center overflow-hidden rounded border px-2 text-[11px] font-bold shadow-sm transition-[left,top,width,transform,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing ${highlighted ? 'z-20' : 'z-10'} ${hasLockConflict ? 'ring-2 ring-amber-500' : ''}`}
title={`${formatBarTitle(bar.flightNumber, bar.start, bar.end, bar.counter)}${hasLockConflict ? ` | LockConflict ${bar.lockConflicts.map((lock) => lock.name).join(', ')}` : ''}`}
```

Render an icon:

```tsx
{hasLockConflict && (
  <span className="material-symbols-outlined pointer-events-none absolute right-1 top-0.5 text-[12px] text-amber-900">lock</span>
)}
```

- [ ] **Step 6: Verify Task 5**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npx eslint src/app/checkin/page.tsx src/lib/checkinAllocation.ts src/lib/checkInCounterSettings.ts scripts/rule-regression-tests.cjs"
```

Expected: both commands exit 0.

---

### Task 6: Documentation And Full Verification

**Files:**
- Modify: `context.md`
- Verify: touched app files

- [ ] **Step 1: Update context**

Add to `context.md` under `### Check-in Allocation`:

```md
- Global `OperationalSettings` owns check-in counter inventory, counter groups, BHS mappings, and time-bound counter locks.
- Check-in Allocation can use configured counter resources instead of fallback rows and can reorder the Resource Grid by counter group through the `Group by island` toggle.
- Allocating counters mapped to a counter group writes the group's BHS value to the departure modification locally; broken allocations spanning groups write a unique comma-separated BHS list.
- Active counter locks block new allocation edits that overlap the lock window, but existing allocations remain visible and are marked as lock conflicts until users manually resolve them.
```

- [ ] **Step 2: Run full verification**

Run:

```powershell
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run test:rules"
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npx eslint src/app/settings/page.tsx src/app/checkin/page.tsx src/lib/settingsRules.ts src/lib/checkInCounterSettings.ts src/lib/checkinAllocation.ts scripts/rule-regression-tests.cjs"
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npx tsc --noEmit --pretty false"
rtk proxy powershell -NoProfile -Command "Set-Location -LiteralPath 'C:\Users\tuan\Documents\SeasonalManagement\app'; npm run build"
```

Expected: all commands exit 0.

- [ ] **Step 3: Probe routes**

Run:

```powershell
rtk proxy powershell -NoProfile -Command '$checkin = Invoke-WebRequest -UseBasicParsing -Uri ''http://localhost:3000/checkin'' -TimeoutSec 10; $settings = Invoke-WebRequest -UseBasicParsing -Uri ''http://localhost:3000/settings'' -TimeoutSec 10; Write-Output (''Checkin={0}; Settings={1}; CheckinText={2}; SettingsText={3}'' -f $checkin.StatusCode, $settings.StatusCode, ($checkin.Content -like ''*Check-in Allocation*''), ($settings.Content -like ''*Settings*''))'
```

Expected:

```text
Checkin=200; Settings=200; CheckinText=True; SettingsText=True
```

- [ ] **Step 4: Final report**

Report:

- Files changed.
- Verification commands and outcomes.
- Whether route probes passed.
- Note that git commit was not run because `git` is unavailable on PATH.
