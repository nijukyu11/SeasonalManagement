# Check-in Allocation - Discrete Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/checkin` tab with an interactive local-first Gantt chart for departure check-in counter allocation using discrete row-confined grouped bars.

**Architecture:** Add check-in allocation fields to the existing `FlightRecord` / `FlightModification` model, then isolate all date, counter, rule, layout, and validation logic in a pure `checkinAllocation` helper. Wire a new Next.js `/checkin` route to the same IndexedDB workspace and manual Sync flow used by Daily Schedule, keeping the React route focused on rendering and pointer/context-menu events.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, Material Symbols, IndexedDB via `localSeasonStore`, Firestore manual sync via `seasonSync`, existing Counter Rule engine in `settingsRules`, regression harness in `app/scripts/rule-regression-tests.cjs`.

---

## File Structure

- Modify: `app/src/lib/types.ts`
  - Add check-in allocation fields to `FlightLeg`, `FlightRecord`, and `FlightModification`.
- Modify: `app/src/lib/persistenceSchema.ts`
  - Validate optional `checkInStart` / `checkInEnd` datetime strings and preserve the new fields through record/modification serialization.
- Modify: `app/src/lib/localSeasonStore.ts`
  - Include check-in fields in no-op modification comparison so pending operation counts clear when values return to baseline.
- Create: `app/src/lib/checkinAllocation.ts`
  - Pure helper for timeline ticks, default windows, counter normalization, rule-derived demand, unallocated/resource models, discrete bar generation, overlap validation, and allocation transformations.
- Modify: `app/scripts/rule-regression-tests.cjs`
  - Compile `checkinAllocation.ts` and add regressions for persistence and allocation behavior.
- Create: `app/src/app/checkin/page.tsx`
  - Check-in Allocation route with local-first workspace loading, time controller, split-pane Gantt, context menu, override popover, and Sync.
- Modify: `app/src/app/page.tsx`
  - Add Check-in Allocation navigation from Seasonal Schedule.
- Modify: `app/src/app/daily/page.tsx`
  - Add Check-in Allocation navigation from Daily Schedule.
- Modify: `app/src/app/detailed/page.tsx`
  - Add Check-in Allocation navigation from Detailed Schedule.
- Modify: `app/src/app/settings/page.tsx`
  - Add Check-in Allocation navigation from Settings.
- Modify: `context.md`
  - Document the new tab and discrete grouped-bar rendering rule.

---

### Task 1: Check-in Fields And Persistence

**Files:**
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/persistenceSchema.ts`
- Modify: `app/src/lib/localSeasonStore.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add failing persistence regressions**

In `app/scripts/rule-regression-tests.cjs`, inside `run()` near the existing persistence tests for `serializeFlightRecordForPersistence` and `serializeFlightModificationForPersistence`, add:

```js
  const persistedCheckInRecord = serializeFlightRecordForPersistence({
    ...operationalRecord,
    id: 'CHECKIN_RECORD',
    checkInStart: '2026-05-08T04:45',
    checkInEnd: '2026-05-08T07:15',
    checkInAllocationMode: 'grouped',
  });
  assert(
    persistedCheckInRecord.checkInStart === '2026-05-08T04:45' &&
      persistedCheckInRecord.checkInEnd === '2026-05-08T07:15' &&
      persistedCheckInRecord.checkInAllocationMode === 'grouped',
    `check-in allocation fields should persist on flight records, got ${JSON.stringify(persistedCheckInRecord)}`
  );

  const hydratedCheckInRecord = hydrateFlightRecordFromPersistence({
    ...persistedCheckInRecord,
    flightType: undefined,
  });
  assert(
    hydratedCheckInRecord.checkInStart === '2026-05-08T04:45' &&
      hydratedCheckInRecord.checkInEnd === '2026-05-08T07:15' &&
      hydratedCheckInRecord.checkInAllocationMode === 'grouped',
    `check-in allocation fields should hydrate on flight records, got ${JSON.stringify(hydratedCheckInRecord)}`
  );

  const persistedCheckInMod = serializeFlightModificationForPersistence({
    legId: 'CHECKIN_RECORD',
    action: 'modified',
    counter: [1, 2, 5],
    checkInStart: '2026-05-08T05:00',
    checkInEnd: '2026-05-08T07:30',
    checkInAllocationMode: 'broken',
  });
  assert(
    Array.isArray(persistedCheckInMod.counter) &&
      persistedCheckInMod.checkInStart === '2026-05-08T05:00' &&
      persistedCheckInMod.checkInEnd === '2026-05-08T07:30' &&
      persistedCheckInMod.checkInAllocationMode === 'broken',
    `check-in allocation fields should persist on modifications, got ${JSON.stringify(persistedCheckInMod)}`
  );

  let invalidCheckInTimeError = null;
  try {
    serializeFlightModificationForPersistence({
      legId: 'CHECKIN_INVALID',
      action: 'modified',
      checkInStart: '2026-05-08 05:00',
    });
  } catch (err) {
    invalidCheckInTimeError = err;
  }
  assert(
    invalidCheckInTimeError?.message.includes('checkInStart must use yyyy-mm-ddTHH:mm format'),
    `invalid check-in datetime should be rejected, got ${invalidCheckInTimeError?.message}`
  );
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
npm run test:rules
```

Expected: FAIL because TypeScript/runtime objects do not yet validate or type the new fields, and the invalid datetime is not rejected.

- [ ] **Step 3: Add domain types**

In `app/src/lib/types.ts`, add this type near `FlightCounter`:

```ts
export type CheckInAllocationMode = 'grouped' | 'broken';
```

Then add these fields to `FlightLeg` after `counter: FlightCounter;`:

```ts
  checkInStart?: string | null;
  checkInEnd?: string | null;
  checkInAllocationMode?: CheckInAllocationMode | null;
```

Add the same fields to `FlightModification` after `counter?: FlightCounter;`:

```ts
  checkInStart?: string | null;
  checkInEnd?: string | null;
  checkInAllocationMode?: CheckInAllocationMode | null;
```

- [ ] **Step 4: Add persistence validation**

In `app/src/lib/persistenceSchema.ts`, add a datetime regex next to `OPERATIONAL_TIME_PATTERN`:

```ts
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
```

Add these helpers after `assertOperationalTimeField`:

```ts
function assertCheckInDateTimeField(value: string | null | undefined, fieldName: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !LOCAL_DATETIME_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use yyyy-mm-ddTHH:mm format.`);
  }
}

function assertCheckInAllocationMode(value: unknown): void {
  if (value == null) return;
  if (value !== 'grouped' && value !== 'broken') {
    throw new Error('checkInAllocationMode must be grouped or broken.');
  }
}
```

Then update `assertOperationalFields`:

```ts
  assertCheckInDateTimeField(value.checkInStart, 'checkInStart');
  assertCheckInDateTimeField(value.checkInEnd, 'checkInEnd');
  assertCheckInAllocationMode(value.checkInAllocationMode);
```

- [ ] **Step 5: Hydrate field defaults**

In `app/src/lib/persistenceSchema.ts`, update `OperationalFieldDefaults`:

```ts
type OperationalFieldDefaults = Pick<
  FlightLeg,
  'pax' | 'gate' | 'stand' | 'counter' | 'carousel' | 'mct' | 'fb' | 'lb' | 'bhs' | 'ghs' | 'checkInStart' | 'checkInEnd' | 'checkInAllocationMode'
>;
```

Then add these defaults inside `hydrateOperationalFields`:

```ts
    checkInStart: leg.checkInStart ?? null,
    checkInEnd: leg.checkInEnd ?? null,
    checkInAllocationMode: leg.checkInAllocationMode ?? null,
```

- [ ] **Step 6: Include check-in fields in pending-op no-op comparison**

In `app/src/lib/localSeasonStore.ts`, add these entries to `fieldPairs` inside `isNoOpModificationAgainstBaseRecord`:

```ts
    ['checkInStart', 'checkInStart'],
    ['checkInEnd', 'checkInEnd'],
    ['checkInAllocationMode', 'checkInAllocationMode'],
```

- [ ] **Step 7: Run the regression and verify it passes**

Run:

```bash
npm run test:rules
```

Expected: PASS.

---

### Task 2: Pure Check-in Allocation Helper

**Files:**
- Create: `app/src/lib/checkinAllocation.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add the helper to the test harness compile list**

In `app/scripts/rule-regression-tests.cjs`, add `checkinAllocation` to `compileFixtureModules()`:

```js
  for (const name of ['types', 'importSeasonRules', 'parser', 'exporter', 'sourceRowPatterns', 'atomicSchedule', 'firestoreWritePlanner', 'importProgress', 'settingsRules', 'modHistorySizing', 'detailedScheduleState', 'dailySchedule', 'dailyScheduleImport', 'checkinAllocation', 'seasonDataCache', 'seasonalLinkActions', 'localSeasonStore', 'seasonSync', 'seasonalDisplayAggregator', 'persistenceSchema']) {
```

Inside `run()`, add a require block after the `dailyScheduleImport.js` require:

```js
  const {
    CHECKIN_SNAP_MINUTES,
    addCheckInCounter,
    allocateCheckInCounters,
    breakCheckInAllocation,
    buildCheckInAllocationView,
    buildCheckInTimelineTicks,
    buildDefaultCheckInWindow,
    buildDefaultCounterRoster,
    chooseCheckInLabelMode,
    moveCheckInAllocation,
    normalizeCheckInCounterList,
    overrideCheckInTimes,
    removeCheckInCounter,
    resizeCheckInAllocation,
    unallocateCheckInRecord,
  } = require(path.join(tempDir, 'checkinAllocation.js'));
```

- [ ] **Step 2: Add failing helper regressions**

Append this block after the existing Daily Schedule import regressions:

```js
  const checkInRecord = {
    id: 'CHECKIN-VJ827',
    linkId: 'CHECKIN-VJ827',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ827',
    rawFlightNumber: '827',
    requestStatusCode: null,
    route: 'SGN',
    schedule: '07:45',
    aircraft: '321',
    category: 'J',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: null,
    pax: 180,
    gate: 5,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-05-08',
    dayOfWeek: 5,
    action: null,
    sourceRowIndex: 90,
    sourceKind: 'imported',
    sourceSide: 'DEP',
    status: 'active',
  };
  const checkInSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [{
      id: 'vj-321',
      name: 'VJ 321 default',
      enabled: true,
      priorityScore: 10,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      conditions: { aircraftTypes: ['321'], aircraftGroups: [], airlineCodes: ['VJ'] },
      counterValue: 3,
    }],
    updatedAt: 1,
  });

  const defaultWindow = buildDefaultCheckInWindow(checkInRecord);
  assert(
    defaultWindow.start === '2026-05-08T04:45' &&
      defaultWindow.end === '2026-05-08T06:55',
    `default check-in window should be STD -3h to -50m, got ${JSON.stringify(defaultWindow)}`
  );
  assert(CHECKIN_SNAP_MINUTES === 15, `check-in snap should be 15 minutes, got ${CHECKIN_SNAP_MINUTES}`);
  assert(
    JSON.stringify(normalizeCheckInCounterList('1,2,5')) === JSON.stringify([1, 2, 5]) &&
      JSON.stringify(normalizeCheckInCounterList('1-3')) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(normalizeCheckInCounterList(['M1', 'M2'])) === JSON.stringify(['M1', 'M2']),
    'check-in counter normalization should handle CSV, ranges, and arrays'
  );
  assert(
    JSON.stringify(buildDefaultCounterRoster([{ ...checkInRecord, counter: [3, 1, 'M2'] }])) === JSON.stringify([1, 3, 'M2']),
    `default counter roster should sort assigned counters, got ${JSON.stringify(buildDefaultCounterRoster([{ ...checkInRecord, counter: [3, 1, 'M2'] }]))}`
  );

  const allocated = allocateCheckInCounters({
    record: checkInRecord,
    records: [checkInRecord],
    modifications: new Map(),
    settings: checkInSettings,
    roster: [1, 2, 3, 4, 5, 'M1'],
    startCounter: 1,
  });
  assert(
    JSON.stringify(allocated.counter) === JSON.stringify([1, 2, 3]) &&
      allocated.checkInAllocationMode === 'grouped',
    `allocating should assign contiguous counters and grouped mode, got ${JSON.stringify(allocated)}`
  );

  const allocatedView = buildCheckInAllocationView({
    records: [checkInRecord],
    modifications: new Map([['CHECKIN-VJ827', { legId: 'CHECKIN-VJ827', action: 'modified', ...allocated }]]),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3, 4, 5, 'M1'],
    pixelsPerMinute: 4,
  });
  assert(
    allocatedView.resourceBars.length === 3 &&
      allocatedView.resourceBars.every((bar) => bar.flightNumber === 'VJ827') &&
      JSON.stringify(allocatedView.resourceBars.map((bar) => bar.counter)) === JSON.stringify([1, 2, 3]),
    `grouped allocation should render one discrete bar per counter, got ${JSON.stringify(allocatedView.resourceBars)}`
  );

  const broken = breakCheckInAllocation({ record: checkInRecord, currentCounter: [1, 2, 3] });
  assert(broken.checkInAllocationMode === 'broken', `break shape should set broken mode, got ${JSON.stringify(broken)}`);

  const moved = moveCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    roster: [1, 2, 3, 4, 5],
    rowDelta: 1,
    minuteDelta: 15,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(moved.counter) === JSON.stringify([2, 3, 4]) &&
      moved.checkInStart === '2026-05-08T05:00' &&
      moved.checkInEnd === '2026-05-08T07:10',
    `grouped move should shift counters and snapped time together, got ${JSON.stringify(moved)}`
  );

  const resized = resizeCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    edge: 'end',
    minuteDelta: 15,
    records: [],
    modifications: new Map(),
  });
  assert(resized.checkInEnd === '2026-05-08T07:10', `resize should update shared end time, got ${JSON.stringify(resized)}`);

  let checkInOverlapError = null;
  try {
    moveCheckInAllocation({
      record: { ...checkInRecord, counter: [1], checkInAllocationMode: 'grouped' },
      roster: [1, 2, 3],
      rowDelta: 0,
      minuteDelta: 0,
      records: [{ ...checkInRecord, id: 'CHECKIN-CONFLICT', flightNumber: 'VJ828', schedule: '08:00', counter: [1] }],
      modifications: new Map(),
    });
  } catch (err) {
    checkInOverlapError = err;
  }
  assert(
    checkInOverlapError?.message.includes('overlaps'),
    `same-counter overlapping check-in windows should be rejected, got ${checkInOverlapError?.message}`
  );

  const overridden = overrideCheckInTimes({
    record: checkInRecord,
    start: '2026-05-08T05:00',
    end: '2026-05-08T07:30',
  });
  assert(
    overridden.checkInStart === '2026-05-08T05:00' && overridden.checkInEnd === '2026-05-08T07:30',
    `override times should persist exact values, got ${JSON.stringify(overridden)}`
  );

  const addedCounter = addCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2], checkInAllocationMode: 'grouped' },
    roster: [1, 2, 3],
    records: [],
    modifications: new Map(),
  });
  assert(JSON.stringify(addedCounter.counter) === JSON.stringify([1, 2, 3]), `add counter should append next contiguous row, got ${JSON.stringify(addedCounter)}`);

  const removedCounter = removeCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    clickedCounter: 2,
  });
  assert(JSON.stringify(removedCounter.counter) === JSON.stringify([1, 2]), `remove grouped counter should remove lowest row, got ${JSON.stringify(removedCounter)}`);

  const unallocatedCheckIn = unallocateCheckInRecord({ ...checkInRecord, counter: [1, 2], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T07:30', checkInAllocationMode: 'grouped' });
  assert(
    unallocatedCheckIn.counter === null &&
      unallocatedCheckIn.checkInStart === null &&
      unallocatedCheckIn.checkInEnd === null &&
      unallocatedCheckIn.checkInAllocationMode === null,
    `unallocate should clear counter and check-in overrides, got ${JSON.stringify(unallocatedCheckIn)}`
  );

  assert(
    chooseCheckInLabelMode(220) === 'full' &&
      chooseCheckInLabelMode(120) === 'flightOnly',
    `label mode should hide times first when narrow, got ${chooseCheckInLabelMode(220)} / ${chooseCheckInLabelMode(120)}`
  );

  const ticks = buildCheckInTimelineTicks('2026-05-08T04:00', '2026-05-08T05:00');
  assert(
    ticks.minor.length === 5 &&
      ticks.major.some((tick) => tick.label === '04:00') &&
      ticks.macro.some((tick) => tick.label.includes('2026-05-08')),
    `timeline ticks should include macro, hour, and 15-minute ticks, got ${JSON.stringify(ticks)}`
  );
```

- [ ] **Step 3: Run the regression and verify it fails**

Run:

```bash
npm run test:rules
```

Expected: FAIL because `checkinAllocation.ts` does not exist.

- [ ] **Step 4: Create `checkinAllocation.ts` with public types and utilities**

Create `app/src/lib/checkinAllocation.ts` with this structure:

```ts
import { evaluateCounterRules } from './settingsRules';
import type { CheckInAllocationMode, FlightCounter, FlightModification, FlightRecord, OperationalSettings } from './types';

export const CHECKIN_SNAP_MINUTES = 15;
const DEFAULT_START_OFFSET_MINUTES = -180;
const DEFAULT_END_OFFSET_MINUTES = -50;
const FULL_LABEL_MIN_WIDTH = 180;

export type CheckInCounter = string | number;
export type CheckInLabelMode = 'full' | 'flightOnly';

export interface CheckInWindow {
  start: string;
  end: string;
}

export interface CheckInTimelineTick {
  at: string;
  label: string;
  leftPercent: number;
}

export interface CheckInTimelineTicks {
  macro: CheckInTimelineTick[];
  major: CheckInTimelineTick[];
  minor: CheckInTimelineTick[];
}

export interface CheckInFlightItem {
  record: FlightRecord;
  requiredCounters: number;
  ruleName: string;
  window: CheckInWindow;
}

export interface CheckInResourceBar {
  id: string;
  recordId: string;
  groupId: string;
  counter: CheckInCounter;
  counterIndex: number;
  flightNumber: string;
  mode: CheckInAllocationMode;
  start: string;
  end: string;
  startLabel: string;
  endLabel: string;
  leftPercent: number;
  widthPercent: number;
  labelMode: CheckInLabelMode;
}

export interface CheckInAllocationView {
  roster: CheckInCounter[];
  unallocated: CheckInFlightItem[];
  resourceBars: CheckInResourceBar[];
}
```

- [ ] **Step 5: Implement datetime helpers**

In `checkinAllocation.ts`, add:

```ts
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function parseLocalDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local datetime ${value}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

function recordStdDateTime(record: Pick<FlightRecord, 'date' | 'schedule'>): string {
  return `${record.date}T${record.schedule}`;
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function addMinutes(value: string, minutes: number): string {
  const date = parseLocalDateTime(value);
  date.setMinutes(date.getMinutes() + minutes);
  return formatLocalDateTime(date);
}

function minuteDiff(from: string, to: string): number {
  return Math.round((parseLocalDateTime(to).getTime() - parseLocalDateTime(from).getTime()) / 60000);
}

function timeLabel(value: string): string {
  return value.slice(11, 16);
}

function intersects(left: CheckInWindow, right: CheckInWindow): boolean {
  return parseLocalDateTime(left.start).getTime() < parseLocalDateTime(right.end).getTime() &&
    parseLocalDateTime(left.end).getTime() > parseLocalDateTime(right.start).getTime();
}
```

- [ ] **Step 6: Implement window, counter, and roster helpers**

Add:

```ts
export function buildDefaultCheckInWindow(record: Pick<FlightRecord, 'date' | 'schedule'>): CheckInWindow {
  const std = recordStdDateTime(record);
  return {
    start: addMinutes(std, DEFAULT_START_OFFSET_MINUTES),
    end: addMinutes(std, DEFAULT_END_OFFSET_MINUTES),
  };
}

function effectiveWindow(record: FlightRecord, mod?: FlightModification | null): CheckInWindow {
  const fallback = buildDefaultCheckInWindow(record);
  return {
    start: mod?.checkInStart ?? record.checkInStart ?? fallback.start,
    end: mod?.checkInEnd ?? record.checkInEnd ?? fallback.end,
  };
}

function parseCounterToken(value: string): CheckInCounter[] {
  const token = value.trim().toUpperCase();
  if (!token) return [];
  const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start > end) throw new Error(`Invalid counter range ${value}`);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  if (/^\d+$/.test(token)) return [Number(token)];
  return [token];
}

export function normalizeCheckInCounterList(counter: FlightCounter): CheckInCounter[] {
  if (counter == null) return [];
  if (typeof counter === 'string') return counter.split(',').flatMap(parseCounterToken);
  if (Array.isArray(counter)) return counter.flatMap((item) => normalizeCheckInCounterList(String(item)));
  return Object.values(counter).flatMap((item) => normalizeCheckInCounterList(item as FlightCounter));
}

function counterSortKey(counter: CheckInCounter): [number, string, number] {
  if (typeof counter === 'number') return [0, '', counter];
  const match = /^([A-Z]+)(\d+)$/.exec(counter);
  if (match) return [1, match[1], Number(match[2])];
  return [1, counter, 0];
}

export function sortCheckInCounters(counters: CheckInCounter[]): CheckInCounter[] {
  return [...new Set(counters)].sort((left, right) => {
    const a = counterSortKey(left);
    const b = counterSortKey(right);
    return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || String(left).localeCompare(String(right));
  });
}

export function buildDefaultCounterRoster(records: Array<Pick<FlightRecord, 'counter'>>): CheckInCounter[] {
  const assigned = records.flatMap((record) => normalizeCheckInCounterList(record.counter));
  if (assigned.length > 0) return sortCheckInCounters(assigned);
  return [...Array.from({ length: 20 }, (_, index) => index + 1), 'M1', 'M2', 'M3', 'M4', 'M5'];
}
```

- [ ] **Step 7: Implement rule demand and timeline ticks**

Add:

```ts
function requiredCounters(record: FlightRecord, settings: OperationalSettings): { count: number; ruleName: string } {
  const result = evaluateCounterRules(record, settings);
  return {
    count: result.counterValue ?? 1,
    ruleName: result.rule?.name ?? 'Default',
  };
}

export function buildCheckInTimelineTicks(from: string, to: string): CheckInTimelineTicks {
  const totalMinutes = Math.max(1, minuteDiff(from, to));
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  const minor: CheckInTimelineTick[] = [];
  const major: CheckInTimelineTick[] = [];
  const macro: CheckInTimelineTick[] = [];
  const cursor = new Date(start);
  cursor.setMinutes(Math.floor(cursor.getMinutes() / CHECKIN_SNAP_MINUTES) * CHECKIN_SNAP_MINUTES, 0, 0);

  while (cursor <= end) {
    const at = formatLocalDateTime(cursor);
    const leftPercent = Math.max(0, Math.min(100, (minuteDiff(from, at) / totalMinutes) * 100));
    minor.push({ at, label: timeLabel(at), leftPercent });
    if (cursor.getMinutes() === 0) major.push({ at, label: timeLabel(at), leftPercent });
    if (cursor.getHours() === 0 && cursor.getMinutes() === 0 || macro.length === 0) {
      macro.push({ at, label: at.slice(0, 10), leftPercent });
    }
    cursor.setMinutes(cursor.getMinutes() + CHECKIN_SNAP_MINUTES);
  }
  return { macro, major, minor };
}

export function chooseCheckInLabelMode(widthPx: number): CheckInLabelMode {
  return widthPx >= FULL_LABEL_MIN_WIDTH ? 'full' : 'flightOnly';
}
```

- [ ] **Step 8: Implement view model generation**

Add:

```ts
function effectiveRecord(record: FlightRecord, mod?: FlightModification | null): FlightRecord {
  return {
    ...record,
    counter: 'counter' in (mod ?? {}) ? mod?.counter ?? null : record.counter,
    checkInStart: 'checkInStart' in (mod ?? {}) ? mod?.checkInStart ?? null : record.checkInStart ?? null,
    checkInEnd: 'checkInEnd' in (mod ?? {}) ? mod?.checkInEnd ?? null : record.checkInEnd ?? null,
    checkInAllocationMode: 'checkInAllocationMode' in (mod ?? {}) ? mod?.checkInAllocationMode ?? null : record.checkInAllocationMode ?? null,
  };
}

function modeFor(record: FlightRecord, counters: CheckInCounter[], roster: CheckInCounter[]): CheckInAllocationMode {
  if (record.checkInAllocationMode) return record.checkInAllocationMode;
  const indexes = counters.map((counter) => roster.findIndex((item) => item === counter)).filter((index) => index >= 0);
  const contiguous = indexes.length > 0 && indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1);
  return contiguous ? 'grouped' : 'broken';
}

export function buildCheckInAllocationView(input: {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  from: string;
  to: string;
  roster?: CheckInCounter[];
  pixelsPerMinute: number;
}): CheckInAllocationView {
  const roster = input.roster ?? buildDefaultCounterRoster(input.records);
  const range = { start: input.from, end: input.to };
  const unallocated: CheckInFlightItem[] = [];
  const resourceBars: CheckInResourceBar[] = [];
  const totalMinutes = Math.max(1, minuteDiff(input.from, input.to));

  for (const sourceRecord of input.records) {
    if (sourceRecord.status === 'deleted' || sourceRecord.type !== 'D') continue;
    const mod = input.modifications.get(sourceRecord.id) ?? null;
    const record = effectiveRecord(sourceRecord, mod);
    const window = effectiveWindow(record, mod);
    if (!intersects(window, range)) continue;
    const demand = requiredCounters(record, input.settings);
    const counters = normalizeCheckInCounterList(record.counter);
    if (counters.length === 0) {
      unallocated.push({ record, requiredCounters: demand.count, ruleName: demand.ruleName, window });
      continue;
    }
    const mode = modeFor(record, counters, roster);
    const leftPercent = (minuteDiff(input.from, window.start) / totalMinutes) * 100;
    const widthPercent = (minuteDiff(window.start, window.end) / totalMinutes) * 100;
    const widthPx = Math.max(0, minuteDiff(window.start, window.end) * input.pixelsPerMinute);
    for (const counter of counters) {
      const counterIndex = roster.findIndex((item) => item === counter);
      if (counterIndex < 0) continue;
      resourceBars.push({
        id: `${record.id}:${counter}`,
        recordId: record.id,
        groupId: record.id,
        counter,
        counterIndex,
        flightNumber: record.flightNumber,
        mode,
        start: window.start,
        end: window.end,
        startLabel: timeLabel(window.start),
        endLabel: timeLabel(window.end),
        leftPercent,
        widthPercent,
        labelMode: chooseCheckInLabelMode(widthPx),
      });
    }
  }

  unallocated.sort((a, b) =>
    a.window.start.localeCompare(b.window.start) ||
    a.record.schedule.localeCompare(b.record.schedule) ||
    a.record.flightNumber.localeCompare(b.record.flightNumber)
  );
  return { roster, unallocated, resourceBars };
}
```

- [ ] **Step 9: Implement allocation transformations and validation**

Add:

```ts
function assertWindowValid(window: CheckInWindow): void {
  if (parseLocalDateTime(window.start).getTime() >= parseLocalDateTime(window.end).getTime()) {
    throw new Error('Check-in start must be before end.');
  }
}

function toCounterPayload(counters: CheckInCounter[]): FlightCounter {
  return counters;
}

function findContiguousCounters(roster: CheckInCounter[], startCounter: CheckInCounter, count: number): CheckInCounter[] {
  const startIndex = roster.findIndex((counter) => counter === startCounter);
  if (startIndex < 0) throw new Error(`Counter ${startCounter} is not in the roster.`);
  const counters = roster.slice(startIndex, startIndex + count);
  if (counters.length !== count) throw new Error('Not enough contiguous counters from selected row.');
  return counters;
}

function mergedMod(record: FlightRecord, patch: Partial<FlightModification>): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    ...patch,
  };
}

function assertNoCheckInOverlap(
  record: FlightRecord,
  counters: CheckInCounter[],
  window: CheckInWindow,
  records: FlightRecord[],
  modifications: Map<string, FlightModification>
): void {
  const counterKeys = new Set(counters.map(String));
  for (const sourceRecord of records) {
    if (sourceRecord.id === record.id || sourceRecord.status === 'deleted' || sourceRecord.type !== 'D') continue;
    const mod = modifications.get(sourceRecord.id) ?? null;
    const other = effectiveRecord(sourceRecord, mod);
    const sharedCounter = normalizeCheckInCounterList(other.counter).find((counter) => counterKeys.has(String(counter)));
    if (sharedCounter == null) continue;
    if (intersects(window, effectiveWindow(other, mod))) {
      throw new Error(`Counter ${sharedCounter} overlaps with ${other.flightNumber}.`);
    }
  }
}

export function allocateCheckInCounters(input: {
  record: FlightRecord;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  roster: CheckInCounter[];
  startCounter: CheckInCounter;
}): FlightModification {
  const demand = requiredCounters(input.record, input.settings);
  const counters = findContiguousCounters(input.roster, input.startCounter, demand.count);
  const window = effectiveWindow(input.record, input.modifications.get(input.record.id) ?? null);
  assertWindowValid(window);
  assertNoCheckInOverlap(input.record, counters, window, input.records, input.modifications);
  return mergedMod(input.record, {
    counter: toCounterPayload(counters),
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: 'grouped',
  });
}

export function breakCheckInAllocation(input: { record: FlightRecord; currentCounter?: FlightCounter }): FlightModification {
  return mergedMod(input.record, {
    counter: input.currentCounter ?? input.record.counter,
    checkInAllocationMode: 'broken',
  });
}

export function moveCheckInAllocation(input: {
  record: FlightRecord;
  roster: CheckInCounter[];
  rowDelta: number;
  minuteDelta: number;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const counters = normalizeCheckInCounterList(input.record.counter);
  const movedCounters = counters.map((counter) => {
    const index = input.roster.findIndex((item) => item === counter);
    const next = input.roster[index + input.rowDelta];
    if (index < 0 || next == null) throw new Error('Grouped move would leave the counter roster.');
    return next;
  });
  const window = effectiveWindow(input.record, input.modifications.get(input.record.id) ?? null);
  const nextWindow = {
    start: addMinutes(window.start, input.minuteDelta),
    end: addMinutes(window.end, input.minuteDelta),
  };
  assertWindowValid(nextWindow);
  assertNoCheckInOverlap(input.record, movedCounters, nextWindow, input.records, input.modifications);
  return mergedMod(input.record, {
    counter: toCounterPayload(movedCounters),
    checkInStart: nextWindow.start,
    checkInEnd: nextWindow.end,
    checkInAllocationMode: input.record.checkInAllocationMode ?? 'grouped',
  });
}

export function resizeCheckInAllocation(input: {
  record: FlightRecord;
  edge: 'start' | 'end';
  minuteDelta: number;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const window = effectiveWindow(input.record, input.modifications.get(input.record.id) ?? null);
  const nextWindow = input.edge === 'start'
    ? { ...window, start: addMinutes(window.start, input.minuteDelta) }
    : { ...window, end: addMinutes(window.end, input.minuteDelta) };
  assertWindowValid(nextWindow);
  assertNoCheckInOverlap(input.record, normalizeCheckInCounterList(input.record.counter), nextWindow, input.records, input.modifications);
  return mergedMod(input.record, {
    checkInStart: nextWindow.start,
    checkInEnd: nextWindow.end,
    checkInAllocationMode: input.record.checkInAllocationMode ?? 'grouped',
  });
}

export function overrideCheckInTimes(input: {
  record: FlightRecord;
  start: string;
  end: string;
  records?: FlightRecord[];
  modifications?: Map<string, FlightModification>;
}): FlightModification {
  const window = { start: input.start, end: input.end };
  assertWindowValid(window);
  assertNoCheckInOverlap(input.record, normalizeCheckInCounterList(input.record.counter), window, input.records ?? [], input.modifications ?? new Map());
  return mergedMod(input.record, {
    checkInStart: input.start,
    checkInEnd: input.end,
    checkInAllocationMode: input.record.checkInAllocationMode ?? null,
  });
}

export function addCheckInCounter(input: {
  record: FlightRecord;
  roster: CheckInCounter[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const counters = normalizeCheckInCounterList(input.record.counter);
  const indexes = counters.map((counter) => input.roster.findIndex((item) => item === counter));
  const next = input.roster[Math.max(...indexes) + 1];
  if (next == null) throw new Error('No available contiguous counter to add.');
  assertNoCheckInOverlap(input.record, [...counters, next], effectiveWindow(input.record, input.modifications.get(input.record.id) ?? null), input.records, input.modifications);
  return mergedMod(input.record, {
    counter: toCounterPayload([...counters, next]),
    checkInAllocationMode: input.record.checkInAllocationMode ?? 'grouped',
  });
}

export function removeCheckInCounter(input: { record: FlightRecord; clickedCounter?: CheckInCounter }): FlightModification {
  const counters = normalizeCheckInCounterList(input.record.counter);
  if (counters.length <= 1) throw new Error('Use Unallocate to clear the last counter.');
  const nextCounters = input.record.checkInAllocationMode === 'broken' && input.clickedCounter != null
    ? counters.filter((counter) => counter !== input.clickedCounter)
    : counters.slice(0, -1);
  return mergedMod(input.record, {
    counter: toCounterPayload(nextCounters),
    checkInAllocationMode: input.record.checkInAllocationMode ?? 'grouped',
  });
}

export function unallocateCheckInRecord(record: FlightRecord): FlightModification {
  return mergedMod(record, {
    counter: null,
    checkInStart: null,
    checkInEnd: null,
    checkInAllocationMode: null,
  });
}
```

- [ ] **Step 10: Run helper regressions**

Run:

```bash
npm run test:rules
```

Expected: PASS.

---

### Task 3: Check-in Route Local-First Shell

**Files:**
- Create: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/settings/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add failing route/source regressions**

In `app/scripts/rule-regression-tests.cjs`, near existing source scans for route requirements, add:

```js
  const checkInPagePath = path.join(root, 'src', 'app', 'checkin', 'page.tsx');
  assert(fs.existsSync(checkInPagePath), 'Check-in Allocation route must exist at src/app/checkin/page.tsx');
  const checkInPageSource = fs.readFileSync(checkInPagePath, 'utf8');
  assert(
    checkInPageSource.includes('syncSeasonWorkspace') &&
      checkInPageSource.includes('loadLocalSeasonWorkspace') &&
      checkInPageSource.includes('applyLocalModificationBatch') &&
      !checkInPageSource.includes('window.location.reload') &&
      !/\b(alert|confirm)\s*\(/.test(checkInPageSource),
    'Check-in route must use local-first workspace helpers, manual Sync, and shared dialogs only'
  );
  assert(
    checkInPageSource.includes('Check-in Allocation') &&
      checkInPageSource.includes('Unallocated Pool') &&
      checkInPageSource.includes('Resource Grid'),
    'Check-in route must render the approved split-pane Gantt labels'
  );

  for (const routeFile of [
    path.join(root, 'src', 'app', 'page.tsx'),
    path.join(root, 'src', 'app', 'daily', 'page.tsx'),
    path.join(root, 'src', 'app', 'detailed', 'page.tsx'),
    path.join(root, 'src', 'app', 'settings', 'page.tsx'),
  ]) {
    const source = fs.readFileSync(routeFile, 'utf8');
    assert(source.includes('/checkin'), `${path.relative(root, routeFile)} should link to Check-in Allocation`);
  }
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
npm run test:rules
```

Expected: FAIL because `/checkin/page.tsx` does not exist.

- [ ] **Step 3: Create the route imports and helpers**

Create `app/src/app/checkin/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  getFlightRecords,
  getModHistory,
  getModifications,
  getOperationalSettings,
  getSeasons,
  getSourceRows,
} from '@/lib/firestore';
import { mergePersistedFlightRecords } from '@/lib/atomicSchedule';
import {
  buildCheckInAllocationView,
  buildCheckInTimelineTicks,
  type CheckInCounter,
  type CheckInResourceBar,
} from '@/lib/checkinAllocation';
import {
  getCachedSeasonData,
  getCachedSeasons,
  patchCachedSeasonData,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  applyLocalModificationBatch,
  createLocalWorkspace,
  loadLocalSeasonWorkspace,
  saveLocalSeasonWorkspace,
} from '@/lib/localSeasonStore';
import type { LocalSeasonWorkspace } from '@/lib/localSeasonStore';
import { syncSeasonWorkspace } from '@/lib/seasonSync';
import type { FlightModification, FlightRecord, ModHistoryEntry, OperationalSettings, Season } from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';

const PIXELS_PER_MINUTE = 4;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const today = todayIso();
  return { from: `${today}T04:00`, to: `${today}T12:00` };
}

function displayCounter(counter: CheckInCounter): string {
  return typeof counter === 'number' ? `C${counter}` : String(counter);
}

function makeHistoryEntry(description: string, previousMod: FlightModification | null, newMod: FlightModification): ModHistoryEntry {
  return {
    id: `CHECKIN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    description,
    changes: [{ legId: newMod.legId, previousMod, newMod }],
  };
}
```

- [ ] **Step 4: Implement local workspace loading shell**

Inside `page.tsx`, add:

```tsx
function CheckInAllocationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { dialogNode, showAlert } = useAppDialog();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [season, setSeason] = useState<Season | null>(null);
  const [records, setRecords] = useState<FlightRecord[]>([]);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [settings, setSettings] = useState<OperationalSettings>({ aircraftGroups: [], counterAllocationRules: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({ pendingCount: 0, lastLocalChangeAt: null });
  const [range, setRange] = useState(defaultRange);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const currentMutationRef = useRef<Promise<void>>(Promise.resolve());

  const applyWorkspace = useCallback((workspace: LocalSeasonWorkspace) => {
    setSeason(workspace.season);
    setRecords(workspace.records);
    setModifications(workspace.modifications);
    setModHistory(workspace.modHistory);
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    setCachedSeasonData(workspace.season.id, {
      rows: workspace.rows,
      records: workspace.records,
      modifications: workspace.modifications,
      modHistory: workspace.modHistory,
    });
  }, []);

  const enqueueLocalMutation = useCallback(async (work: () => Promise<void>) => {
    const next = currentMutationRef.current.then(work, work);
    currentMutationRef.current = next.catch(() => undefined);
    await next;
  }, []);
```

- [ ] **Step 5: Add route data load effect**

Continue inside `CheckInAllocationContent`:

```tsx
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [loadedSeasons, loadedSettings] = await Promise.all([
          getCachedSeasons() ?? getSeasons(),
          getOperationalSettings(),
        ]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setSeasons(loadedSeasons);
        setCachedSeasons(loadedSeasons);

        const requestedSeasonId = searchParams.get('season');
        const targetSeason = loadedSeasons.find((item) => item.id === requestedSeasonId) ?? loadedSeasons[0] ?? null;
        if (!targetSeason) {
          setSeason(null);
          setRecords([]);
          setModifications(new Map());
          setModHistory([]);
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          return;
        }

        const localWorkspace = await loadLocalSeasonWorkspace(targetSeason.id);
        if (cancelled) return;
        if (localWorkspace) {
          applyWorkspace(localWorkspace);
          return;
        }

        const cached = getCachedSeasonData(targetSeason.id);
        if (cached) {
          const workspace = createLocalWorkspace({
            season: targetSeason,
            rows: cached.rows,
            records: cached.records,
            modifications: cached.modifications,
            modHistory: cached.modHistory,
          });
          await saveLocalSeasonWorkspace(workspace);
          if (!cancelled) applyWorkspace(workspace);
          return;
        }

        const [rows, fetchedRecords, fetchedMods, history] = await Promise.all([
          getSourceRows(targetSeason.id),
          getFlightRecords(targetSeason.id),
          getModifications(targetSeason.id),
          getModHistory(targetSeason.id),
        ]);
        const hydrated = mergePersistedFlightRecords(rows, fetchedRecords);
        const workspace = createLocalWorkspace({
          season: targetSeason,
          rows,
          records: hydrated.records,
          modifications: fetchedMods,
          modHistory: history,
          baseRecords: fetchedRecords,
          pendingOps: hydrated.needsFullPersist
            ? hydrated.records.map((record) => ({ type: 'flightRecord' as const, record }))
            : [],
        });
        await saveLocalSeasonWorkspace(workspace);
        if (!cancelled) applyWorkspace(workspace);
      } catch (err) {
        if (!cancelled) void showAlert({ title: 'Check-in Load Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyWorkspace, searchParams, showAlert]);
```

- [ ] **Step 6: Build memoized view and Sync handler**

Continue inside `CheckInAllocationContent`:

```tsx
  const checkInView = useMemo(() => buildCheckInAllocationView({
    records,
    modifications,
    settings,
    from: range.from,
    to: range.to,
    pixelsPerMinute: PIXELS_PER_MINUTE,
  }), [modifications, range.from, range.to, records, settings]);

  const timeline = useMemo(() => buildCheckInTimelineTicks(range.from, range.to), [range.from, range.to]);

  const refreshWorkspaceState = useCallback((seasonId: string, workspace: LocalSeasonWorkspace) => {
    setRecords(workspace.records);
    setModifications(workspace.modifications);
    setModHistory(workspace.modHistory);
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(seasonId, {
      records: workspace.records,
      modifications: workspace.modifications,
      modHistory: workspace.modHistory,
    });
  }, []);

  const commitModification = useCallback(async (description: string, mod: FlightModification) => {
    if (!season) return;
    const seasonId = season.id;
    await enqueueLocalMutation(async () => {
      const workspace = await loadLocalSeasonWorkspace(seasonId);
      if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
      const previousMod = workspace.modifications.get(mod.legId) ?? null;
      const historyEntry = makeHistoryEntry(description, previousMod, mod);
      const nextWorkspace = await applyLocalModificationBatch(seasonId, [mod], historyEntry);
      refreshWorkspaceState(seasonId, nextWorkspace);
    });
  }, [enqueueLocalMutation, refreshWorkspaceState, season]);

  const handleSync = useCallback(async () => {
    if (!season || syncing) return;
    setSyncing(true);
    setSyncProgress('Finishing local changes');
    try {
      await currentMutationRef.current;
      setSyncProgress('Preparing sync');
      const result = await syncSeasonWorkspace(season.id, (label, written, total) => {
        setSyncProgress(`${label}: ${written} / ${total}`);
      });
      const workspace = await loadLocalSeasonWorkspace(season.id);
      if (workspace) applyWorkspace(workspace);
      if (result.status !== 'synced') {
        void showAlert({ title: 'Sync Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Sync Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }, [applyWorkspace, season, showAlert, syncing]);
```

- [ ] **Step 7: Add minimal route render shell**

Return a shell with the approved labels:

```tsx
  return (
    <div className="flex h-screen flex-col bg-surface text-on-surface">
      {dialogNode}
      <header className="flex flex-none items-center justify-between border-b border-outline-variant bg-surface-container-lowest px-4 py-3">
        <div className="flex items-center gap-4">
          <button onClick={() => router.push('/')} className="text-sm font-semibold text-on-surface-variant">Seasonal Schedule</button>
          <button onClick={() => router.push(`/daily${season ? `?season=${season.id}` : ''}`)} className="text-sm font-semibold text-on-surface-variant">Daily Schedule</button>
          <button onClick={() => router.push(`/detailed${season ? `?season=${season.id}` : ''}`)} className="text-sm font-semibold text-on-surface-variant">Detailed Schedule</button>
          <span className="rounded border border-primary bg-primary px-2 py-1 text-sm font-semibold text-on-primary">Check-in Allocation</span>
          <button onClick={() => router.push('/settings')} className="text-sm font-semibold text-on-surface-variant">Settings</button>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={season?.id ?? ''}
            onChange={(event) => router.push(`/checkin?season=${event.target.value}`)}
            disabled={seasons.length === 0 || syncing}
            className="rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-sm"
          >
            {seasons.map((item) => <option key={item.id} value={item.id}>{item.seasonCode}</option>)}
          </select>
          <span className={`rounded border px-2 py-1 text-xs font-semibold ${syncSummary.pendingCount > 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
            {syncSummary.pendingCount > 0 ? `${syncSummary.pendingCount} unsynced` : 'Synced'}
          </span>
          <button onClick={handleSync} disabled={syncing || syncSummary.pendingCount === 0} className="rounded bg-primary px-3 py-2 text-sm font-semibold text-on-primary disabled:opacity-50">
            {syncing ? 'Syncing' : 'Sync'}
          </button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <section className="flex flex-none items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Check-in Allocation</h1>
            <p className="text-xs text-on-surface-variant">15 min snap</p>
          </div>
          <div className="flex items-center gap-2">
            <input type="datetime-local" value={range.from} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} className="rounded border border-outline-variant bg-surface-container-low px-2 py-1 text-sm" />
            <input type="datetime-local" value={range.to} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} className="rounded border border-outline-variant bg-surface-container-low px-2 py-1 text-sm" />
          </div>
        </section>
        <section className="grid flex-none grid-cols-3 gap-2 text-sm">
          <div className="rounded border border-outline-variant bg-surface-container-lowest p-2">Unallocated: {checkInView.unallocated.length}</div>
          <div className="rounded border border-outline-variant bg-surface-container-lowest p-2">Allocated: {new Set(checkInView.resourceBars.map((bar) => bar.recordId)).size}</div>
          <div className="rounded border border-outline-variant bg-surface-container-lowest p-2">Counters: {checkInView.roster.length}</div>
        </section>
        <section className="min-h-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest">
          {loading ? (
            <div className="flex h-full items-center justify-center text-primary">Loading</div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-outline-variant p-2 text-sm font-semibold">Unallocated Pool</div>
              <div className="h-32 border-b border-outline-variant" />
              <div className="border-b border-outline-variant p-2 text-sm font-semibold">Resource Grid</div>
              <div className="min-h-0 flex-1" />
            </div>
          )}
        </section>
        {syncProgress && <div className="flex-none rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-sm">{syncProgress}</div>}
      </main>
    </div>
  );
}

export default function CheckInAllocationPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-surface text-primary">Loading</div>}>
      <CheckInAllocationContent />
    </Suspense>
  );
}
```

- [ ] **Step 8: Add navigation links to existing pages**

In each route file listed above, add a button/link that navigates to `/checkin` and includes the current `season` id when that route already tracks one. For example in `/daily` and `/detailed` headers:

```tsx
<button
  onClick={() => router.push(`/checkin${season ? `?season=${season.id}` : ''}`)}
  className="text-sm font-semibold text-on-surface-variant hover:text-primary"
>
  Check-in Allocation
</button>
```

In `app/src/app/settings/page.tsx`, use:

```tsx
<button
  onClick={() => router.push('/checkin')}
  className="text-sm font-semibold text-on-surface-variant hover:text-primary"
>
  Check-in Allocation
</button>
```

In `app/src/app/page.tsx`, use the page's selected season id variable if available; otherwise link to `/checkin`.

- [ ] **Step 9: Run route regressions**

Run:

```bash
npm run test:rules
```

Expected: PASS.

---

### Task 4: Gantt Rendering And Operations

**Files:**
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add source-level rendering regressions**

In `app/scripts/rule-regression-tests.cjs`, extend the Check-in route source assertions:

```js
  assert(
    checkInPageSource.includes('gridTemplateRows') &&
      checkInPageSource.includes('selectedGroupId') &&
      checkInPageSource.includes('labelMode') &&
      checkInPageSource.includes('draggable') &&
      checkInPageSource.includes('onDrop') &&
      checkInPageSource.includes('data-resize-edge') &&
      checkInPageSource.includes('Break Shape') &&
      checkInPageSource.includes('Override Times') &&
      checkInPageSource.includes('Start') &&
      checkInPageSource.includes('End'),
    'Check-in route must render discrete row bars, grouped selection, context menu, and override time controls'
  );
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
npm run test:rules
```

Expected: FAIL because the render shell does not yet include the full Gantt UI.

- [ ] **Step 3: Add interaction imports**

Update the `checkinAllocation` import in `app/src/app/checkin/page.tsx`:

```tsx
import {
  addCheckInCounter,
  allocateCheckInCounters,
  breakCheckInAllocation,
  buildCheckInAllocationView,
  buildCheckInTimelineTicks,
  moveCheckInAllocation,
  overrideCheckInTimes,
  removeCheckInCounter,
  resizeCheckInAllocation,
  unallocateCheckInRecord,
  type CheckInCounter,
  type CheckInResourceBar,
} from '@/lib/checkinAllocation';
```

- [ ] **Step 4: Add UI state for grouped selection, context menu, and override popover**

Inside `CheckInAllocationContent`, add:

```tsx
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bar: CheckInResourceBar } | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<CheckInResourceBar | null>(null);
  const [overrideDraft, setOverrideDraft] = useState({ start: '', end: '' });
  const [pointerDrag, setPointerDrag] = useState<{
    kind: 'move' | 'resize-start' | 'resize-end';
    bar: CheckInResourceBar;
    originX: number;
    originY: number;
  } | null>(null);
```

Add:

```tsx
  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedRecordId) ?? null,
    [records, selectedRecordId]
  );

  const barByRecordId = useMemo(() => {
    const map = new Map<string, CheckInResourceBar[]>();
    for (const bar of checkInView.resourceBars) {
      map.set(bar.recordId, [...(map.get(bar.recordId) ?? []), bar]);
    }
    return map;
  }, [checkInView.resourceBars]);
```

- [ ] **Step 5: Add action handlers**

Inside `CheckInAllocationContent`, add:

```tsx
  const findRecord = useCallback((recordId: string): FlightRecord => {
    const record = records.find((item) => item.id === recordId);
    if (!record) throw new Error(`Flight record ${recordId} not found`);
    return record;
  }, [records]);

  const runBarAction = useCallback(async (description: string, build: () => FlightModification) => {
    try {
      const mod = build();
      await commitModification(description, mod);
      setContextMenu(null);
    } catch (err) {
      void showAlert({ title: 'Check-in Allocation', message: (err as Error).message, tone: 'error' });
    }
  }, [commitModification, showAlert]);

  const handleAllocateFromPool = useCallback(async (record: FlightRecord, startCounter: CheckInCounter) => {
    await runBarAction(`Allocate ${record.flightNumber}`, () => allocateCheckInCounters({
      record,
      records,
      modifications,
      settings,
      roster: checkInView.roster,
      startCounter,
    }));
  }, [checkInView.roster, modifications, records, runBarAction, settings]);

  const handleBreakShape = useCallback((bar: CheckInResourceBar) => {
    void runBarAction(`Break ${bar.flightNumber}`, () => breakCheckInAllocation({
      record: findRecord(bar.recordId),
      currentCounter: barByRecordId.get(bar.recordId)?.map((item) => item.counter) ?? null,
    }));
  }, [barByRecordId, findRecord, runBarAction]);

  const handleAddCounter = useCallback((bar: CheckInResourceBar) => {
    void runBarAction(`Add counter ${bar.flightNumber}`, () => addCheckInCounter({
      record: findRecord(bar.recordId),
      roster: checkInView.roster,
      records,
      modifications,
    }));
  }, [checkInView.roster, findRecord, modifications, records, runBarAction]);

  const handleRemoveCounter = useCallback((bar: CheckInResourceBar) => {
    void runBarAction(`Remove counter ${bar.flightNumber}`, () => removeCheckInCounter({
      record: findRecord(bar.recordId),
      clickedCounter: bar.counter,
    }));
  }, [findRecord, runBarAction]);

  const handleUnallocate = useCallback((bar: CheckInResourceBar) => {
    void runBarAction(`Unallocate ${bar.flightNumber}`, () => unallocateCheckInRecord(findRecord(bar.recordId)));
  }, [findRecord, runBarAction]);

  const handleMoveBar = useCallback((bar: CheckInResourceBar, minuteDelta: number, rowDelta: number) => {
    void runBarAction(`Move ${bar.flightNumber}`, () => moveCheckInAllocation({
      record: findRecord(bar.recordId),
      roster: checkInView.roster,
      rowDelta,
      minuteDelta,
      records,
      modifications,
    }));
  }, [checkInView.roster, findRecord, modifications, records, runBarAction]);

  const handleResizeBar = useCallback((bar: CheckInResourceBar, edge: 'start' | 'end', minuteDelta: number) => {
    void runBarAction(`Resize ${bar.flightNumber}`, () => resizeCheckInAllocation({
      record: findRecord(bar.recordId),
      edge,
      minuteDelta,
      records,
      modifications,
    }));
  }, [findRecord, modifications, records, runBarAction]);

  useEffect(() => {
    if (!pointerDrag) return;
    const handlePointerUp = (event: PointerEvent) => {
      const rawMinuteDelta = (event.clientX - pointerDrag.originX) / PIXELS_PER_MINUTE;
      const minuteDelta = Math.round(rawMinuteDelta / 15) * 15;
      const rowDelta = Math.round((event.clientY - pointerDrag.originY) / 40);
      if (pointerDrag.kind === 'move') handleMoveBar(pointerDrag.bar, minuteDelta, rowDelta);
      if (pointerDrag.kind === 'resize-start') handleResizeBar(pointerDrag.bar, 'start', minuteDelta);
      if (pointerDrag.kind === 'resize-end') handleResizeBar(pointerDrag.bar, 'end', minuteDelta);
      setPointerDrag(null);
    };
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, [handleMoveBar, handleResizeBar, pointerDrag]);

  const openOverride = useCallback((bar: CheckInResourceBar) => {
    setOverrideTarget(bar);
    setOverrideDraft({ start: bar.start, end: bar.end });
    setContextMenu(null);
  }, []);

  const applyOverride = useCallback(async () => {
    if (!overrideTarget) return;
    await runBarAction(`Override check-in times ${overrideTarget.flightNumber}`, () => overrideCheckInTimes({
      record: findRecord(overrideTarget.recordId),
      start: overrideDraft.start,
      end: overrideDraft.end,
      records,
      modifications,
    }));
    setOverrideTarget(null);
  }, [findRecord, modifications, overrideDraft.end, overrideDraft.start, overrideTarget, records, runBarAction]);
```

- [ ] **Step 6: Render timeline header**

Add a helper component above `CheckInAllocationContent`:

```tsx
function TimelineHeader({ timeline }: { timeline: ReturnType<typeof buildCheckInTimelineTicks> }) {
  return (
    <div className="relative h-14 border-b border-outline-variant bg-surface-container-low text-[11px] text-on-surface-variant">
      {timeline.minor.map((tick) => (
        <div key={`minor-${tick.at}`} className="absolute bottom-0 top-0 border-l border-outline-variant/50" style={{ left: `${tick.leftPercent}%` }} />
      ))}
      {timeline.macro.map((tick) => (
        <div key={`macro-${tick.at}`} className="absolute left-0 top-1 font-semibold" style={{ left: `${tick.leftPercent}%` }}>{tick.label}</div>
      ))}
      {timeline.major.map((tick) => (
        <div key={`major-${tick.at}`} className="absolute bottom-1 font-mono text-[11px]" style={{ left: `${tick.leftPercent}%` }}>{tick.label}</div>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Render discrete row-confined bars**

Add a helper component above `CheckInAllocationContent`:

```tsx
function ResourceBar({
  bar,
  selected,
  onSelect,
  onContextMenu,
  onPointerStart,
}: {
  bar: CheckInResourceBar;
  selected: boolean;
  onSelect: (bar: CheckInResourceBar) => void;
  onContextMenu: (event: React.MouseEvent, bar: CheckInResourceBar) => void;
  onPointerStart: (event: React.PointerEvent, kind: 'move' | 'resize-start' | 'resize-end', bar: CheckInResourceBar) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(bar)}
      onPointerDown={(event) => onPointerStart(event, 'move', bar)}
      onContextMenu={(event) => onContextMenu(event, bar)}
      title={`${bar.startLabel} ${bar.flightNumber} ${bar.endLabel}`}
      className={`absolute top-1 bottom-1 overflow-hidden rounded border px-1 text-[11px] font-semibold tabular-nums transition ${
        selected
          ? 'border-primary bg-primary text-on-primary shadow-[0_0_0_2px_rgba(13,148,136,0.22)]'
          : bar.mode === 'broken'
            ? 'border-secondary bg-secondary-container text-on-secondary-container'
            : 'border-primary/70 bg-primary-container text-on-primary-container'
      }`}
      style={{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }}
    >
      <span data-resize-edge="start" onPointerDown={(event) => onPointerStart(event, 'resize-start', bar)} className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize bg-white/20" />
      <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] opacity-90">{bar.labelMode === 'full' ? bar.startLabel : ''}</span>
      <span className="block truncate px-10 text-center">{bar.flightNumber}</span>
      <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] opacity-90">{bar.labelMode === 'full' ? bar.endLabel : ''}</span>
      <span data-resize-edge="end" onPointerDown={(event) => onPointerStart(event, 'resize-end', bar)} className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize bg-white/20" />
    </button>
  );
}
```

- [ ] **Step 8: Replace the initial Gantt body with the split-pane Gantt**

Replace the initial split-pane body with:

```tsx
              <div className="grid h-14 grid-cols-[88px_1fr] border-b border-outline-variant">
                <div className="border-r border-outline-variant bg-surface-container-low p-2 text-xs font-semibold">Timeline</div>
                <TimelineHeader timeline={timeline} />
              </div>
              <div className="grid h-32 grid-cols-[88px_1fr] border-b border-outline-variant">
                <div className="border-r border-outline-variant bg-surface-container-low p-2 text-xs font-semibold">Unallocated Pool</div>
                <div className="relative overflow-hidden bg-surface-container-lowest">
                  {checkInView.unallocated.map((item, index) => (
                    <button
                      key={item.record.id}
                      type="button"
                      onClick={() => setSelectedRecordId(item.record.id)}
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData('application/x-checkin-record-id', item.record.id)}
                      className="absolute h-7 rounded border border-tertiary-container bg-tertiary-fixed px-2 text-left text-[11px] font-semibold text-on-tertiary-fixed"
                      style={{ left: `${8 + index * 18}%`, top: `${10 + (index % 3) * 34}px`, minWidth: 130 }}
                    >
                      {item.record.flightNumber} ({item.requiredCounters})
                      <span className="ml-2 font-normal">{item.record.schedule} {item.record.route}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[88px_1fr]">
                <div className="border-r border-outline-variant bg-surface-container-low">
                  {checkInView.roster.map((counter) => {
                    const selectedBars = selectedGroupId ? barByRecordId.get(selectedGroupId) ?? [] : [];
                    const grouped = selectedBars.some((bar) => bar.counter === counter);
                    return (
                      <div key={String(counter)} className="relative flex h-10 items-center border-b border-outline-variant px-2 text-xs font-semibold">
                        {grouped && <span className="absolute left-0 h-7 w-1 rounded-r bg-primary" />}
                        {displayCounter(counter)}
                      </div>
                    );
                  })}
                </div>
                <div
                  className="relative"
                  style={{ gridTemplateRows: `repeat(${checkInView.roster.length}, 40px)` }}
                >
                  {checkInView.roster.map((counter, rowIndex) => (
                    <div
                      key={String(counter)}
                      className="relative h-10 border-b border-outline-variant bg-surface-container-lowest"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const recordId = event.dataTransfer.getData('application/x-checkin-record-id');
                        const record = records.find((item) => item.id === recordId);
                        if (record) void handleAllocateFromPool(record, counter);
                      }}
                    >
                      {timeline.minor.map((tick) => (
                        <div key={`${counter}-${tick.at}`} className="absolute bottom-0 top-0 border-l border-outline-variant/40" style={{ left: `${tick.leftPercent}%` }} />
                      ))}
                      {checkInView.resourceBars.filter((bar) => bar.counterIndex === rowIndex).map((bar) => (
                        <ResourceBar
                          key={bar.id}
                          bar={bar}
                          selected={selectedGroupId === bar.groupId}
                          onSelect={(nextBar) => {
                            setSelectedGroupId(nextBar.groupId);
                            setSelectedRecordId(nextBar.recordId);
                          }}
                          onContextMenu={(event, nextBar) => {
                            event.preventDefault();
                            setSelectedGroupId(nextBar.groupId);
                            setSelectedRecordId(nextBar.recordId);
                            setContextMenu({ x: event.clientX, y: event.clientY, bar: nextBar });
                          }}
                          onPointerStart={(event, kind, nextBar) => {
                            event.stopPropagation();
                            setSelectedGroupId(nextBar.groupId);
                            setSelectedRecordId(nextBar.recordId);
                            setPointerDrag({ kind, bar: nextBar, originX: event.clientX, originY: event.clientY });
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
```

- [ ] **Step 9: Render context menu and override popover**

Before the closing root `</div>`, add:

```tsx
      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded border border-outline-variant bg-surface-container-lowest py-1 text-sm shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className="block w-full px-3 py-2 text-left hover:bg-surface-container" onClick={() => handleBreakShape(contextMenu.bar)}>Break Shape</button>
          <button className="block w-full px-3 py-2 text-left hover:bg-surface-container" onClick={() => handleAddCounter(contextMenu.bar)}>Add Counter</button>
          <button className="block w-full px-3 py-2 text-left hover:bg-surface-container" onClick={() => handleRemoveCounter(contextMenu.bar)}>Remove Counter</button>
          <button className="block w-full px-3 py-2 text-left hover:bg-surface-container" onClick={() => openOverride(contextMenu.bar)}>Override Times</button>
          <button className="block w-full px-3 py-2 text-left text-error hover:bg-error-container" onClick={() => handleUnallocate(contextMenu.bar)}>Unallocate</button>
        </div>
      )}
      {overrideTarget && (
        <div className="fixed right-6 top-32 z-50 w-80 rounded-lg border border-outline-variant bg-surface-container-lowest p-3 shadow-lg">
          <div className="mb-2 text-sm font-semibold">Override Times</div>
          <label className="mb-2 block text-xs font-semibold text-on-surface-variant">
            Start
            <input type="datetime-local" value={overrideDraft.start} onChange={(event) => setOverrideDraft((current) => ({ ...current, start: event.target.value }))} className="mt-1 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 text-sm" />
          </label>
          <label className="mb-3 block text-xs font-semibold text-on-surface-variant">
            End
            <input type="datetime-local" value={overrideDraft.end} onChange={(event) => setOverrideDraft((current) => ({ ...current, end: event.target.value }))} className="mt-1 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 text-sm" />
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setOverrideTarget(null)} className="rounded border border-outline-variant px-3 py-1 text-sm">Cancel</button>
            <button onClick={applyOverride} className="rounded bg-primary px-3 py-1 text-sm font-semibold text-on-primary">Apply</button>
          </div>
        </div>
      )}
```

- [ ] **Step 10: Run route rendering regressions**

Run:

```bash
npm run test:rules
```

Expected: PASS.

---

### Task 5: Documentation And Verification

**Files:**
- Modify: `context.md`

- [ ] **Step 1: Add context documentation**

In `context.md`, under `## UI Rules`, add a new section before `### Daily Schedule`:

```md
### Check-in Allocation

- Check-in Allocation is a departure-only Gantt route over canonical `flightRecords` plus local modification overlays.
- The Gantt time range controls only the visible x-axis. It does not mutate records by itself.
- Default allocation windows are derived from STD: `STD - 3 hours` to `STD - 50 minutes`.
- Counter demand is initialized from the operational Counter Rule engine. If no rule matches, the route uses one counter.
- Counter assignments persist through the existing `counter` field. Grouped contiguous and broken non-contiguous allocations use array payloads such as `[1, 2, 3]` or `[1, 2, 5]`.
- Check-in allocation time overrides use `checkInStart` and `checkInEnd`; resizing bars must not alter STD.
- Grouped allocations are logical groups, but the UI must render one discrete row-confined bar per assigned counter. It must never render a merged multi-row rectangle.
- Every visible allocation bar repeats the flight identifier. Normal-width bars show left-edge start time and right-edge end time; narrow bars keep the flight identifier and expose times in a tooltip.
- Break Shape changes the interaction mode to independent counter blocks while preserving a shared flight time window.
- All allocation edits are local-first through IndexedDB and wait for manual Sync before Firestore writes.
```

- [ ] **Step 2: Run rule regressions**

Run:

```bash
npm run test:rules
```

Expected: PASS with `rule regression tests passed`.

- [ ] **Step 3: Run targeted lint**

Run:

```bash
npx eslint src/app/checkin/page.tsx src/lib/checkinAllocation.ts src/lib/types.ts src/lib/persistenceSchema.ts src/lib/localSeasonStore.ts
```

Expected: PASS with no errors.

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: PASS. The routes list should include `/checkin`.

- [ ] **Step 5: Start or reuse the local dev server**

Run:

```bash
npm run dev
```

Expected: Next.js dev server starts. If port `3000` is already in use, use the displayed alternate port.

- [ ] **Step 6: Manual browser verification**

Open:

```text
http://localhost:3000/checkin
```

Verify:

- Navigation shows `Check-in Allocation` active.
- Unallocated Pool renders departure flights chronologically.
- Resource Grid rows show counters.
- A grouped allocation renders as one discrete bar per counter row.
- Row grid lines remain visible through grouped allocations.
- Selecting one grouped bar highlights all bars in that group.
- Context menu shows Break Shape, Add Counter, Remove Counter, Override Times, and Unallocate.
- Override Times does not mutate STD.
- Sync button remains disabled when there are no pending changes and enabled after local edits.

---

## Execution Notes

- Use `apply_patch` for manual edits.
- Do not introduce direct Firestore writes in `/checkin`; all edits go through local workspace helpers.
- Do not use native `alert()` or `confirm()`.
- Do not use `window.location.reload()`.
- Keep the route dense and operational; no instructional content in the app body.
- `git` is not currently available on PATH in this shell, so commit steps are intentionally omitted from command blocks. If Git becomes available, commit after each task with a focused message.
