# Daily Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/daily` tab that shows all ARR/DEP flight records inside a selected datetime range in one full-width editable grid.

**Architecture:** Add a pure `dailySchedule` helper module for datetime filtering, ARR/DEP summary counts, linked row consolidation, sort/filter, validation, and inline edit payload mapping. Wire a new Next.js `/daily` route to the existing local-first IndexedDB workspace and manual Sync flow, reusing Detailed Schedule mutation helpers instead of creating a new persistence path.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, IndexedDB via `localSeasonStore`, Firestore manual sync via `seasonSync`, existing rule test harness in `app/scripts/rule-regression-tests.cjs`.

---

## File Structure

- Create: `app/src/lib/dailySchedule.ts`
  - Pure helper module for Daily Schedule row view models, datetime filtering, summary counts, column filters, sorting, inline edit mapping, and validation.
- Modify: `app/scripts/rule-regression-tests.cjs`
  - Compile `dailySchedule.ts` in the temporary test harness and add regressions for the approved rules.
- Create: `app/src/app/daily/page.tsx`
  - Daily Schedule UI route with season loading, date range toolbar, full-width editable grid, row selection, local-first operations, and manual Sync.
- Modify: `app/src/app/page.tsx`
  - Add Daily Schedule navigation from Seasonal Schedule.
- Modify: `app/src/app/detailed/page.tsx`
  - Add Daily Schedule navigation from Detailed Schedule.
- Modify: `context.md`
  - Document Daily Schedule behavior after implementation.

---

### Task 1: Daily Schedule Pure Helpers

**Files:**
- Create: `app/src/lib/dailySchedule.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add the failing helper imports to the rule harness**

In `app/scripts/rule-regression-tests.cjs`, add `dailySchedule` to the `compileFixtureModules()` module list:

```js
for (const name of ['types', 'importSeasonRules', 'parser', 'exporter', 'sourceRowPatterns', 'atomicSchedule', 'firestoreWritePlanner', 'importProgress', 'detailedScheduleState', 'dailySchedule', 'seasonDataCache', 'seasonalLinkActions', 'localSeasonStore', 'seasonSync', 'seasonalDisplayAggregator', 'persistenceSchema']) {
```

Then add this require block inside `run()` after the `detailedScheduleState.js` require:

```js
  const {
    buildDailyScheduleRows,
    buildDefaultDailyDateRange,
    buildDailySummary,
    buildDailyCellModification,
    validateDailyCellEdit,
  } = require(path.join(tempDir, 'dailySchedule.js'));
```

- [ ] **Step 2: Add failing Daily Schedule regressions**

Append this block in `run()` after the existing helper setup and before the final success log:

```js
  const dailyRecords = [
    {
      id: 'arr-early',
      linkId: 'arr-early',
      type: 'A',
      airline: 'TW',
      flightNumber: 'TW018',
      rawFlightNumber: '018',
      requestStatusCode: null,
      route: 'ICN',
      schedule: '04:40',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: 178,
      gate: null,
      stand: 12,
      counter: null,
      bhs: 'C4',
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 1,
      sourceKind: 'imported',
      sourceSide: 'ARR',
      status: 'active',
    },
    {
      id: 'arr-linked',
      linkId: 'turn-1',
      turnaroundId: 'turn-1',
      type: 'A',
      airline: 'TW',
      flightNumber: 'TW118',
      rawFlightNumber: '118',
      requestStatusCode: null,
      route: 'ICN',
      schedule: '06:15',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: 'KE711',
      intDomInd: null,
      pax: 188,
      gate: null,
      stand: 14,
      counter: null,
      bhs: 'C5',
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 2,
      sourceKind: 'imported',
      sourceSide: 'ARR',
      status: 'active',
      linkType: 'sameday',
      pairAnchorDate: '2026-05-08',
      linkedRecordId: 'dep-linked',
    },
    {
      id: 'dep-linked',
      linkId: 'turn-1',
      turnaroundId: 'turn-1',
      type: 'D',
      airline: 'TW',
      flightNumber: 'TW119',
      rawFlightNumber: '119',
      requestStatusCode: null,
      route: 'DAD',
      schedule: '07:05',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: 162,
      gate: 5,
      stand: null,
      counter: '1-4',
      bhs: null,
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 2,
      sourceKind: 'imported',
      sourceSide: 'DEP',
      status: 'active',
      linkType: 'sameday',
      pairAnchorDate: '2026-05-08',
      linkedRecordId: 'arr-linked',
    },
    {
      id: 'dep-late',
      linkId: 'dep-late',
      type: 'D',
      airline: 'TW',
      flightNumber: 'TW220',
      rawFlightNumber: '220',
      requestStatusCode: null,
      route: 'HAN',
      schedule: '05:00',
      aircraft: '32Q',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: 140,
      gate: 6,
      stand: null,
      counter: '5-8',
      bhs: null,
      ghs: null,
      date: '2026-05-09',
      dayOfWeek: 6,
      action: null,
      sourceRowIndex: 3,
      sourceKind: 'imported',
      sourceSide: 'DEP',
      status: 'active',
    },
  ];

  const defaultRange = buildDefaultDailyDateRange('2026-05-08');
  assert(defaultRange.from === '2026-05-08T05:00', `Daily default from should use 05:00, got ${defaultRange.from}`);
  assert(defaultRange.to === '2026-05-09T05:00', `Daily default to should use next-day 05:00, got ${defaultRange.to}`);

  const dailyRows = buildDailyScheduleRows({
    records: dailyRecords,
    modifications: new Map(),
    from: defaultRange.from,
    to: defaultRange.to,
  });
  assert(!dailyRows.some((row) => row.arr?.id === 'arr-early'), 'Daily range must not pull 04:40 into the previous operational day by default');
  assert(dailyRows.length === 1, `Expected one consolidated row inside 05:00 range, got ${dailyRows.length}`);
  assert(dailyRows[0].arr?.id === 'arr-linked' && dailyRows[0].dep?.id === 'dep-linked', 'Linked same-day ARR/DEP should consolidate into one Daily row');

  const wideRows = buildDailyScheduleRows({
    records: dailyRecords,
    modifications: new Map(),
    from: '2026-05-08T00:00',
    to: '2026-05-09T05:01',
  });
  const dailySummary = buildDailySummary(wideRows);
  assert(dailySummary.arr === 2, `Expected ARR 2, got ${dailySummary.arr}`);
  assert(dailySummary.dep === 2, `Expected DEP 2, got ${dailySummary.dep}`);
  assert(dailySummary.total === 4, `Expected TOTAL 4, got ${dailySummary.total}`);

  const staMod = buildDailyCellModification(dailyRecords[1], 'sta', '06:20');
  assert(staMod.legId === 'arr-linked' && staMod.schedule === '06:20', 'STA edit should map to schedule modification for ARR record');
  const carouselMod = buildDailyCellModification(dailyRecords[1], 'carousel', 'C6');
  assert(carouselMod.legId === 'arr-linked' && carouselMod.bhs === 'C6', 'Carousel edit should map to bhs modification');
  const gateMod = buildDailyCellModification(dailyRecords[2], 'gate', '7');
  assert(gateMod.legId === 'dep-linked' && gateMod.gate === 7, 'Gate edit should parse to numeric gate modification');

  const duplicateValidation = validateDailyCellEdit({
    records: dailyRecords,
    modifications: new Map(),
    record: dailyRecords[1],
    field: 'arrFlight',
    value: '018',
  });
  assert(!duplicateValidation.valid && duplicateValidation.message.includes('Duplicate flight number'), 'Duplicate same-day flight edit should be rejected');

  const timeValidation = validateDailyCellEdit({
    records: dailyRecords,
    modifications: new Map(),
    record: dailyRecords[1],
    field: 'sta',
    value: '6am',
  });
  assert(!timeValidation.valid && timeValidation.message.includes('HH:MM'), 'Invalid time edits should be rejected');
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```powershell
cd app
npm run test:rules
```

Expected: FAIL because `app/src/lib/dailySchedule.ts` does not exist yet.

- [ ] **Step 4: Create `dailySchedule.ts` with minimal implementation**

Create `app/src/lib/dailySchedule.ts`:

```ts
import { applyModificationsToFlightLegs } from './detailedScheduleState';
import { findDuplicateFlightNumberViolations, flightRecordsToLegs } from './atomicSchedule';
import type { FlightCounter, FlightLeg, FlightModification, FlightRecord } from './types';

export type DailyCellField =
  | 'aircraft'
  | 'arrFlight'
  | 'depFlight'
  | 'sta'
  | 'std'
  | 'from'
  | 'to'
  | 'arrPax'
  | 'depPax'
  | 'carousel'
  | 'arrStand'
  | 'arrCodeShare'
  | 'gate'
  | 'counters';

export type DailySortDirection = 'asc' | 'desc';

export interface DailyDateRange {
  from: string;
  to: string;
}

export interface DailyScheduleRow {
  id: string;
  arr: FlightLeg | null;
  dep: FlightLeg | null;
  arrIncluded: boolean;
  depIncluded: boolean;
  linkKey: string | null;
  validationMessages: string[];
}

export interface DailySummary {
  arr: number;
  dep: number;
  total: number;
}

export interface DailyBuildInput {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  from: string;
  to: string;
}

export interface DailyValidationInput {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  record: FlightRecord | FlightLeg;
  field: DailyCellField;
  value: string;
}

export interface DailyValidationResult {
  valid: boolean;
  message: string | null;
}

export interface DailyFilterState {
  aircraft?: string;
  arrFlight?: string;
  sta?: string;
  from?: string;
  arrPax?: string;
  carousel?: string;
  arrStand?: string;
  arrCodeShare?: string;
  depFlight?: string;
  std?: string;
  to?: string;
  depPax?: string;
  gate?: string;
  counters?: string;
}

export interface DailySortState {
  field: keyof DailyFilterState;
  direction: DailySortDirection;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function buildDefaultDailyDateRange(baseIsoDate: string): DailyDateRange {
  const start = new Date(`${baseIsoDate}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    from: `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}-${pad2(start.getUTCDate())}T05:00`,
    to: `${end.getUTCFullYear()}-${pad2(end.getUTCMonth() + 1)}-${pad2(end.getUTCDate())}T05:00`,
  };
}

function datetimeToMinute(value: string): number {
  const [datePart, timePart = '00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) / 60000;
}

function recordDatetimeToMinute(record: Pick<FlightLeg, 'date' | 'schedule'>): number {
  return datetimeToMinute(`${record.date}T${record.schedule}`);
}

function isInRange(record: Pick<FlightLeg, 'date' | 'schedule'>, from: string, to: string): boolean {
  const value = recordDatetimeToMinute(record);
  return value >= datetimeToMinute(from) && value < datetimeToMinute(to);
}

function pairKey(leg: FlightLeg): string {
  if (leg.linkedRecordId) return `linked:${[leg.id, leg.linkedRecordId].sort().join(':')}`;
  if (leg.linkId && leg.linkId !== leg.id) return `link:${leg.linkId}:${leg.pairAnchorDate ?? leg.date}`;
  return `single:${leg.id}`;
}

function rowId(arr: FlightLeg | null, dep: FlightLeg | null, key: string): string {
  return arr?.id && dep?.id ? `daily:${arr.id}:${dep.id}` : `daily:${arr?.id ?? dep?.id ?? key}`;
}

export function buildDailyScheduleRows(input: DailyBuildInput): DailyScheduleRow[] {
  const legs = applyModificationsToFlightLegs(flightRecordsToLegs(input.records), input.modifications);
  const visibleLegs = legs.filter((leg) => isInRange(leg, input.from, input.to));
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const grouped = new Map<string, { arr: FlightLeg | null; dep: FlightLeg | null; arrIncluded: boolean; depIncluded: boolean }>();

  for (const leg of visibleLegs) {
    const key = pairKey(leg);
    const group = grouped.get(key) ?? { arr: null, dep: null, arrIncluded: false, depIncluded: false };
    if (leg.type === 'A') {
      group.arr = leg;
      group.arrIncluded = true;
      if (leg.linkedRecordId && !group.dep) group.dep = byId.get(leg.linkedRecordId)?.type === 'D' ? byId.get(leg.linkedRecordId) ?? null : null;
    } else {
      group.dep = leg;
      group.depIncluded = true;
      if (leg.linkedRecordId && !group.arr) group.arr = byId.get(leg.linkedRecordId)?.type === 'A' ? byId.get(leg.linkedRecordId) ?? null : null;
    }
    grouped.set(key, group);
  }

  return Array.from(grouped.entries())
    .map(([key, group]) => ({
      id: rowId(group.arr, group.dep, key),
      arr: group.arrIncluded ? group.arr : null,
      dep: group.depIncluded ? group.dep : null,
      arrIncluded: group.arrIncluded,
      depIncluded: group.depIncluded,
      linkKey: key.startsWith('single:') ? null : key,
      validationMessages: [],
    }))
    .sort((left, right) => {
      const leftMinute = Math.min(
        left.arr ? recordDatetimeToMinute(left.arr) : Number.POSITIVE_INFINITY,
        left.dep ? recordDatetimeToMinute(left.dep) : Number.POSITIVE_INFINITY
      );
      const rightMinute = Math.min(
        right.arr ? recordDatetimeToMinute(right.arr) : Number.POSITIVE_INFINITY,
        right.dep ? recordDatetimeToMinute(right.dep) : Number.POSITIVE_INFINITY
      );
      return leftMinute - rightMinute;
    });
}

export function buildDailySummary(rows: DailyScheduleRow[]): DailySummary {
  const arr = rows.filter((row) => row.arrIncluded).length;
  const dep = rows.filter((row) => row.depIncluded).length;
  return { arr, dep, total: arr + dep };
}

function parseNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error('Value must be numeric.');
  return parsed;
}

function parseCounter(value: string): FlightCounter {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildDailyCellModification(record: Pick<FlightLeg, 'id'>, field: DailyCellField, value: string): FlightModification {
  const trimmed = value.trim();
  const base: FlightModification = { legId: record.id, action: 'modified' };
  if (field === 'aircraft') return { ...base, aircraft: trimmed };
  if (field === 'sta' || field === 'std') return { ...base, schedule: trimmed };
  if (field === 'from' || field === 'to') return { ...base, route: trimmed.toUpperCase() };
  if (field === 'arrPax' || field === 'depPax') return { ...base, pax: parseNumberOrNull(trimmed) };
  if (field === 'carousel') return { ...base, bhs: trimmed || null };
  if (field === 'arrStand') return { ...base, stand: parseNumberOrNull(trimmed) };
  if (field === 'arrCodeShare') return { ...base, codeShares: trimmed || null };
  if (field === 'gate') return { ...base, gate: parseNumberOrNull(trimmed) };
  if (field === 'counters') return { ...base, counter: parseCounter(trimmed) };
  throw new Error(`Unsupported inline edit field: ${field}`);
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function normalizeFlightNumber(airline: string, value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (trimmed.startsWith(airline.toUpperCase())) return trimmed;
  return `${airline.toUpperCase()}${trimmed.padStart(3, '0')}`;
}

export function validateDailyCellEdit(input: DailyValidationInput): DailyValidationResult {
  if ((input.field === 'sta' || input.field === 'std') && !isValidTime(input.value)) {
    return { valid: false, message: 'Time must be HH:MM.' };
  }

  if (['arrPax', 'depPax', 'arrStand', 'gate'].includes(input.field)) {
    try {
      parseNumberOrNull(input.value);
    } catch (err) {
      return { valid: false, message: (err as Error).message };
    }
  }

  if (input.field === 'arrFlight' || input.field === 'depFlight') {
    const nextFlightNumber = normalizeFlightNumber(input.record.airline, input.value);
    const identities = input.records.map((record) => (
      record.id === input.record.id
        ? { ...record, flightNumber: nextFlightNumber }
        : record
    ));
    const violation = findDuplicateFlightNumberViolations(identities).find((entry) => entry.recordIds.includes(input.record.id));
    if (violation) {
      return {
        valid: false,
        message: `Duplicate flight number ${violation.flightNumber} on ${violation.date}.`,
      };
    }
  }

  return { valid: true, message: null };
}

function valueForFilter(row: DailyScheduleRow, field: keyof DailyFilterState): string {
  if (field === 'aircraft') return row.arr?.aircraft ?? row.dep?.aircraft ?? '';
  if (field === 'arrFlight') return row.arr?.flightNumber ?? '';
  if (field === 'sta') return row.arr?.schedule ?? '';
  if (field === 'from') return row.arr?.route ?? '';
  if (field === 'arrPax') return String(row.arr?.pax ?? '');
  if (field === 'carousel') return row.arr?.bhs ?? '';
  if (field === 'arrStand') return String(row.arr?.stand ?? '');
  if (field === 'arrCodeShare') return row.arr?.codeShares ?? '';
  if (field === 'depFlight') return row.dep?.flightNumber ?? '';
  if (field === 'std') return row.dep?.schedule ?? '';
  if (field === 'to') return row.dep?.route ?? '';
  if (field === 'depPax') return String(row.dep?.pax ?? '');
  if (field === 'gate') return String(row.dep?.gate ?? '');
  if (field === 'counters') return typeof row.dep?.counter === 'string' ? row.dep.counter : JSON.stringify(row.dep?.counter ?? '');
  return '';
}

export function filterDailyRows(rows: DailyScheduleRow[], filters: DailyFilterState): DailyScheduleRow[] {
  const activeFilters = Object.entries(filters).filter(([, value]) => value?.trim());
  if (activeFilters.length === 0) return rows;
  return rows.filter((row) => activeFilters.every(([field, value]) => (
    valueForFilter(row, field as keyof DailyFilterState).toLowerCase().includes((value ?? '').toLowerCase())
  )));
}

export function sortDailyRows(rows: DailyScheduleRow[], sort: DailySortState | null): DailyScheduleRow[] {
  if (!sort) return rows;
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => (
    valueForFilter(left, sort.field).localeCompare(valueForFilter(right, sort.field), undefined, { numeric: true }) * direction
  ));
}
```

- [ ] **Step 5: Run helper tests**

Run:

```powershell
cd app
npm run test:rules
```

Expected: PASS for the new Daily Schedule helper regressions and all existing rule tests.

- [ ] **Step 6: Commit**

Run:

```powershell
git add app/src/lib/dailySchedule.ts app/scripts/rule-regression-tests.cjs
git commit -m "feat: add daily schedule helpers"
```

Expected: commit succeeds. If `git` is still unavailable in this environment, record that blocker and continue without committing.

---

### Task 2: Daily Schedule Route Shell and Navigation

**Files:**
- Create: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/page.tsx`
- Modify: `app/src/app/detailed/page.tsx`

- [ ] **Step 1: Add the route skeleton**

Create `app/src/app/daily/page.tsx` with this initial shell:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  getFlightRecords,
  getModHistory,
  getModifications,
  getSeasons,
  getSourceRows,
} from '@/lib/firestore';
import { mergePersistedFlightRecords } from '@/lib/atomicSchedule';
import {
  buildDailyScheduleRows,
  buildDailySummary,
  buildDefaultDailyDateRange,
  filterDailyRows,
  sortDailyRows,
  type DailyFilterState,
  type DailyScheduleRow,
  type DailySortState,
} from '@/lib/dailySchedule';
import {
  createLocalWorkspace,
  loadLocalSeasonWorkspace,
  saveLocalSeasonWorkspace,
} from '@/lib/localSeasonStore';
import {
  getCachedSeasonData,
  getCachedSeasons,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import { syncSeasonWorkspace } from '@/lib/seasonSync';
import type { FlightModification, FlightRecord, ModHistoryEntry, Season } from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';

const COLUMNS: Array<{ key: keyof DailyFilterState; label: string }> = [
  { key: 'aircraft', label: 'A/C Type' },
  { key: 'arrFlight', label: 'Arr Flight' },
  { key: 'sta', label: 'STA' },
  { key: 'from', label: 'From' },
  { key: 'arrPax', label: 'ARR PAX' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'arrStand', label: 'Arr Stand' },
  { key: 'arrCodeShare', label: 'Arr Code Share' },
  { key: 'depFlight', label: 'Dep Flight' },
  { key: 'std', label: 'STD' },
  { key: 'to', label: 'To' },
  { key: 'depPax', label: 'DEP PAX' },
  { key: 'gate', label: 'Gate' },
  { key: 'counters', label: 'Counters' },
];

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function DailyScheduleContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { dialogNode, showAlert } = useAppDialog();
  const targetSeasonId = searchParams.get('season');
  const defaultRange = useMemo(() => buildDefaultDailyDateRange(todayIso()), []);

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [season, setSeason] = useState<Season | null>(null);
  const [records, setRecords] = useState<FlightRecord[]>([]);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [fromDateTime, setFromDateTime] = useState(defaultRange.from);
  const [toDateTime, setToDateTime] = useState(defaultRange.to);
  const [filters, setFilters] = useState<DailyFilterState>({});
  const [sort, setSort] = useState<DailySortState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    lastLocalChangeAt: null,
  });
  const [loading, setLoading] = useState(true);

  const rows = useMemo(() => buildDailyScheduleRows({
    records,
    modifications,
    from: fromDateTime,
    to: toDateTime,
  }), [records, modifications, fromDateTime, toDateTime]);

  const visibleRows = useMemo(() => sortDailyRows(filterDailyRows(rows, filters), sort), [rows, filters, sort]);
  const summary = useMemo(() => buildDailySummary(rows), [rows]);

  const applySeasonWorkspace = useCallback((nextSeason: Season, nextRecords: FlightRecord[], nextMods: Map<string, FlightModification>, nextHistory: ModHistoryEntry[], pendingCount: number, lastLocalChangeAt: number | null) => {
    setSeason(nextSeason);
    setRecords(nextRecords);
    setModifications(nextMods);
    setModHistory(nextHistory);
    setSyncSummary({ pendingCount, lastLocalChangeAt });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const cachedSeasons = getCachedSeasons();
        const loadedSeasons = cachedSeasons.length > 0 ? cachedSeasons : await getSeasons();
        if (cancelled) return;
        setSeasons(loadedSeasons);
        setCachedSeasons(loadedSeasons);
        const selectedSeason = loadedSeasons.find((entry) => entry.id === targetSeasonId) ?? loadedSeasons[0] ?? null;
        if (!selectedSeason) return;

        const localWorkspace = await loadLocalSeasonWorkspace(selectedSeason.id);
        if (cancelled) return;
        if (localWorkspace) {
          applySeasonWorkspace(
            localWorkspace.season,
            localWorkspace.records,
            localWorkspace.modifications,
            localWorkspace.modHistory,
            localWorkspace.syncMeta.pendingCount,
            localWorkspace.syncMeta.lastLocalChangeAt
          );
          return;
        }

        const cached = getCachedSeasonData(selectedSeason.id);
        if (cached) {
          const workspace = createLocalWorkspace({
            season: selectedSeason,
            rows: cached.rows,
            records: cached.records,
            modifications: cached.modifications,
            modHistory: [],
          });
          await saveLocalSeasonWorkspace(workspace);
          applySeasonWorkspace(selectedSeason, cached.records, cached.modifications, [], 0, null);
          return;
        }

        const [rows, fetchedRecords, fetchedMods, fetchedHistory] = await Promise.all([
          getSourceRows(selectedSeason.id),
          getFlightRecords(selectedSeason.id),
          getModifications(selectedSeason.id),
          getModHistory(selectedSeason.id),
        ]);
        const hydrated = mergePersistedFlightRecords(rows, fetchedRecords);
        const workspace = createLocalWorkspace({
          season: selectedSeason,
          rows,
          records: hydrated.records,
          modifications: fetchedMods,
          modHistory: fetchedHistory,
          baseRecords: fetchedRecords,
          pendingOps: hydrated.needsFullPersist
            ? hydrated.records.map((record) => ({ type: 'flightRecord' as const, record }))
            : [],
        });
        await saveLocalSeasonWorkspace(workspace);
        setCachedSeasonData(selectedSeason.id, { rows, records: hydrated.records, modifications: fetchedMods });
        applySeasonWorkspace(
          selectedSeason,
          hydrated.records,
          fetchedMods,
          fetchedHistory,
          workspace.syncMeta.pendingCount,
          workspace.syncMeta.lastLocalChangeAt
        );
      } catch (err) {
        void showAlert({ title: 'Daily Schedule Load Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [applySeasonWorkspace, showAlert, targetSeasonId]);

  const handleSeasonChange = (seasonId: string) => {
    router.push(`/daily?season=${seasonId}`);
  };

  const handleSync = async () => {
    if (!season || syncing) return;
    setSyncing(true);
    setSyncProgress('Preparing sync');
    try {
      const result = await syncSeasonWorkspace(season.id, (label, written, total) => {
        setSyncProgress(`${label}: ${written} / ${total}`);
      });
      const workspace = await loadLocalSeasonWorkspace(season.id);
      if (workspace) {
        applySeasonWorkspace(
          workspace.season,
          workspace.records,
          workspace.modifications,
          workspace.modHistory,
          workspace.syncMeta.pendingCount,
          workspace.syncMeta.lastLocalChangeAt
        );
      }
      void showAlert({
        title: result.status === 'synced' ? 'Sync Complete' : 'Sync Status',
        message: result.message,
        tone: result.status === 'synced' ? 'success' : result.status === 'conflict' ? 'warning' : 'error',
      });
    } catch (err) {
      void showAlert({ title: 'Sync Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  const toggleSort = (field: keyof DailyFilterState) => {
    setSort((current) => {
      if (current?.field !== field) return { field, direction: 'asc' };
      if (current.direction === 'asc') return { field, direction: 'desc' };
      return null;
    });
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="fixed left-0 top-0 h-full z-40 flex flex-col bg-slate-50 dark:bg-slate-950 w-64 border-r border-slate-200 dark:border-slate-800">
        <div className="px-6 py-6 flex items-center gap-3 border-b border-slate-200 dark:border-slate-800">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>flight_takeoff</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xl font-bold text-blue-900 dark:text-blue-50 tracking-tighter">Aviation Command</span>
            <span className="font-sans text-sm font-medium tracking-tight text-slate-500">Ops Control Center</span>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <button onClick={() => router.push('/')} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-sans text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors">
            <span className="material-symbols-outlined">calendar_month</span>
            Seasonal Schedule
          </button>
          <button onClick={() => season && router.push(`/detailed?season=${season.id}`)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-sans text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors">
            <span className="material-symbols-outlined">schedule</span>
            Detailed Schedule
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-sans text-sm font-medium tracking-tight bg-blue-100/50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-r-4 border-blue-700 dark:border-blue-400 transition-colors">
            <span className="material-symbols-outlined">view_list</span>
            Daily Schedule
          </button>
        </nav>
      </aside>

      <div className="flex-1 flex flex-col ml-64 min-w-0 bg-surface h-screen overflow-hidden">
        <header className="sticky top-0 right-0 z-30 flex items-center justify-between px-6 py-3 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-none">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Daily Schedule</h1>
          </div>
          <div className="flex items-center gap-3">
            {seasons.length > 0 && (
              <select value={season?.id ?? ''} onChange={(event) => handleSeasonChange(event.target.value)} className="px-3 py-2 bg-surface-container-low border border-outline-variant text-on-surface text-sm rounded-lg">
                {seasons.map((entry) => <option key={entry.id} value={entry.id}>{entry.seasonCode} - {entry.name}</option>)}
              </select>
            )}
            {season && (
              <>
                <span className={`px-2 py-1 rounded-full text-xs font-semibold border ${syncSummary.pendingCount > 0 ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>
                  {syncSummary.pendingCount > 0 ? `${syncSummary.pendingCount} unsynced` : 'Synced'}
                </span>
                <button disabled={syncing || syncSummary.pendingCount === 0} onClick={handleSync} className="flex items-center gap-2 bg-primary text-on-primary font-label-caps text-label-caps px-3 py-2 rounded-lg hover:bg-primary-container hover:text-on-primary-container transition-colors disabled:opacity-50">
                  <span className={`material-symbols-outlined text-[18px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
                  {syncing ? 'Syncing' : 'Sync'}
                </button>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-hidden p-4 bg-surface flex flex-col gap-3">
          {syncProgress && <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant text-sm text-on-surface-variant">{syncProgress}</div>}

          <section className="bg-surface-container-lowest border border-outline-variant rounded-lg p-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
              From
              <input type="datetime-local" value={fromDateTime} onChange={(event) => setFromDateTime(event.target.value)} className="bg-surface-container-low border border-outline-variant rounded px-2 py-1.5 text-sm text-on-surface" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
              To
              <input type="datetime-local" value={toDateTime} onChange={(event) => setToDateTime(event.target.value)} className="bg-surface-container-low border border-outline-variant rounded px-2 py-1.5 text-sm text-on-surface" />
            </label>
            <button className="px-3 py-1.5 border border-outline-variant rounded text-sm hover:bg-surface-container-low" onClick={() => {
              const next = buildDefaultDailyDateRange(todayIso());
              setFromDateTime(next.from);
              setToDateTime(next.to);
            }}>Today</button>
            <div className="ml-auto flex items-center gap-2 text-sm font-semibold tabular-nums">
              <span className="px-2 py-1 bg-surface-container-low rounded border border-outline-variant">ARR {summary.arr}</span>
              <span className="px-2 py-1 bg-surface-container-low rounded border border-outline-variant">DEP {summary.dep}</span>
              <span className="px-2 py-1 bg-primary text-on-primary rounded border border-primary">TOTAL {summary.total}</span>
            </div>
          </section>

          <section className="bg-surface-container-lowest border border-outline-variant rounded-lg overflow-hidden flex-1 min-h-0">
            {loading ? (
              <div className="p-8 text-center text-on-surface-variant">Loading Daily Schedule...</div>
            ) : (
              <div className="overflow-auto h-full">
                <table className="min-w-[1500px] w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-surface-container-lowest">
                    <tr className="border-b border-outline-variant">
                      <th className="w-10 p-2 text-left"><input type="checkbox" aria-label="Select all visible rows" /></th>
                      {COLUMNS.map((column) => (
                        <th key={column.key} className="p-2 text-left align-bottom border-r border-surface-variant last:border-r-0">
                          <button type="button" className="flex items-center gap-1 font-label-caps text-label-caps text-on-surface-variant" onClick={() => toggleSort(column.key)}>
                            {column.label}
                            <span className="material-symbols-outlined text-[14px]">{sort?.field === column.key ? (sort.direction === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
                          </button>
                          <input
                            value={filters[column.key] ?? ''}
                            onChange={(event) => setFilters((current) => ({ ...current, [column.key]: event.target.value }))}
                            className="mt-1 w-full bg-surface-container-low border border-outline-variant rounded px-1.5 py-1 text-xs font-normal"
                            aria-label={`Filter ${column.label}`}
                          />
                        </th>
                      ))}
                      <th className="w-12 p-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row: DailyScheduleRow) => (
                      <tr key={row.id} className="border-b border-surface-variant hover:bg-surface-container-low">
                        <td className="p-2"><input type="checkbox" checked={selectedIds.has(row.id)} onChange={(event) => {
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          });
                        }} /></td>
                        <td className="p-2 font-data-tabular">{row.arr?.aircraft ?? row.dep?.aircraft ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.arr?.flightNumber ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.arr?.schedule ?? ''}</td>
                        <td className="p-2">{row.arr?.route ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.arr?.pax ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.arr?.bhs ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.arr?.stand ?? ''}</td>
                        <td className="p-2">{row.arr?.codeShares ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.dep?.flightNumber ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.dep?.schedule ?? ''}</td>
                        <td className="p-2">{row.dep?.route ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.dep?.pax ?? ''}</td>
                        <td className="p-2 font-data-tabular">{row.dep?.gate ?? ''}</td>
                        <td className="p-2 font-data-tabular">{typeof row.dep?.counter === 'string' ? row.dep.counter : ''}</td>
                        <td className="p-2"><span className="material-symbols-outlined text-[18px]">more_vert</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
      {dialogNode}
    </div>
  );
}

export default function DailySchedulePage() {
  return (
    <Suspense fallback={<div className="p-8 text-on-surface">Loading...</div>}>
      <DailyScheduleContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Add Daily navigation on Seasonal Schedule**

In `app/src/app/page.tsx`, inside the side nav after the Detailed Schedule button, add:

```tsx
          <button
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-sans text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 hover:bg-slate-200/50 dark:hover:bg-slate-800/50 transition-colors active:scale-95 duration-150"
            onClick={() => activeSeason && router.push(`/daily?season=${activeSeason.id}`)}
          >
            <span className="material-symbols-outlined">view_list</span>
            Daily Schedule
          </button>
```

- [ ] **Step 3: Add Daily navigation on Detailed Schedule**

In `app/src/app/detailed/page.tsx`, inside the side nav after the Detailed Schedule button, add:

```tsx
          <button
            onClick={() => season && router.push(`/daily?season=${season.id}`)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-sans text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
          >
            <span className="material-symbols-outlined">view_list</span>
            Daily Schedule
          </button>
```

- [ ] **Step 4: Run build and targeted lint**

Run:

```powershell
cd app
npx eslint src/app/daily/page.tsx src/app/page.tsx src/app/detailed/page.tsx src/lib/dailySchedule.ts
npm run build
```

Expected: lint passes for touched files and build succeeds.

- [ ] **Step 5: Commit**

Run:

```powershell
git add app/src/app/daily/page.tsx app/src/app/page.tsx app/src/app/detailed/page.tsx
git commit -m "feat: add daily schedule route"
```

Expected: commit succeeds. If `git` is still unavailable, record the blocker and continue without committing.

---

### Task 3: Direct Inline Editing and Local-First Save

**Files:**
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/lib/dailySchedule.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add a failing edit validation regression**

In `app/scripts/rule-regression-tests.cjs`, extend the Daily Schedule block with:

```js
  const validEdit = validateDailyCellEdit({
    records: dailyRecords,
    modifications: new Map(),
    record: dailyRecords[1],
    field: 'sta',
    value: '06:25',
  });
  assert(validEdit.valid && validEdit.message === null, 'Valid HH:MM inline edit should pass validation');
```

- [ ] **Step 2: Run the test**

Run:

```powershell
cd app
npm run test:rules
```

Expected: PASS if Task 1 already handles validation. If it fails, fix `validateDailyCellEdit` before UI wiring.

- [ ] **Step 3: Add an editable cell component to Daily page**

In `app/src/app/daily/page.tsx`, import the edit helpers:

```tsx
  buildDailyCellModification,
  validateDailyCellEdit,
  type DailyCellField,
```

Also import local mutation helpers and cache patching:

```tsx
import {
  applyLocalModificationBatch,
  createLocalWorkspace,
  loadLocalSeasonWorkspace,
  saveLocalSeasonWorkspace,
} from '@/lib/localSeasonStore';
import { patchCachedSeasonData } from '@/lib/seasonDataCache';
import type { FlightLeg } from '@/lib/types';
```

Add this component above `DailyScheduleContent`:

```tsx
function EditableCell({
  value,
  disabled,
  onCommit,
  className = '',
}: {
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => Promise<void>;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    if (disabled || draft === value) return;
    setSaving(true);
    setError(null);
    try {
      await onCommit(draft);
    } catch (err) {
      setError((err as Error).message);
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0">
      <input
        value={draft}
        disabled={disabled || saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        className={`w-full bg-transparent border border-transparent rounded px-1 py-0.5 text-sm hover:border-outline-variant focus:border-primary focus:bg-surface-container-low focus:outline-none disabled:opacity-50 ${className}`}
      />
      {error && <div className="mt-1 text-[11px] text-error leading-tight">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Add commit handler**

Inside `DailyScheduleContent`, add:

```tsx
  const handleCellCommit = async (record: FlightLeg | null | undefined, field: DailyCellField, value: string) => {
    if (!season || !record) return;
    const validation = validateDailyCellEdit({ records, modifications, record, field, value });
    if (!validation.valid) throw new Error(validation.message ?? 'Invalid edit.');
    const mod = buildDailyCellModification(record, field, value);
    const timestamp = Date.now();
    const historyEntry: ModHistoryEntry = {
      id: `LOCAL_DAILY_${timestamp}`,
      timestamp,
      description: `Daily edit ${record.flightNumber}`,
      changes: [{
        legId: mod.legId,
        previousMod: modifications.get(mod.legId) ?? null,
        newMod: mod,
      }],
    };
    const workspace = await applyLocalModificationBatch(season.id, [mod], historyEntry ?? undefined);
    setModifications(workspace.modifications);
    setModHistory(workspace.modHistory);
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, { modifications: workspace.modifications });
  };
```

- [ ] **Step 5: Replace read-only grid cells with `EditableCell`**

In the Daily grid row, replace editable cells with:

```tsx
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={row.arr?.aircraft ?? row.dep?.aircraft ?? ''} disabled={!row.arr && !row.dep} onCommit={(value) => handleCellCommit(row.arr ?? row.dep, 'aircraft', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">{row.arr?.flightNumber ?? ''}</td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={row.arr?.schedule ?? ''} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'sta', value)} />
                        </td>
                        <td className="p-1">
                          <EditableCell value={row.arr?.route ?? ''} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'from', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={String(row.arr?.pax ?? '')} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'arrPax', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={row.arr?.bhs ?? ''} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'carousel', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={String(row.arr?.stand ?? '')} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'arrStand', value)} />
                        </td>
                        <td className="p-1">
                          <EditableCell value={row.arr?.codeShares ?? ''} disabled={!row.arr} onCommit={(value) => handleCellCommit(row.arr, 'arrCodeShare', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">{row.dep?.flightNumber ?? ''}</td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={row.dep?.schedule ?? ''} disabled={!row.dep} onCommit={(value) => handleCellCommit(row.dep, 'std', value)} />
                        </td>
                        <td className="p-1">
                          <EditableCell value={row.dep?.route ?? ''} disabled={!row.dep} onCommit={(value) => handleCellCommit(row.dep, 'to', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={String(row.dep?.pax ?? '')} disabled={!row.dep} onCommit={(value) => handleCellCommit(row.dep, 'depPax', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={String(row.dep?.gate ?? '')} disabled={!row.dep} onCommit={(value) => handleCellCommit(row.dep, 'gate', value)} />
                        </td>
                        <td className="p-1 font-data-tabular">
                          <EditableCell value={typeof row.dep?.counter === 'string' ? row.dep.counter : ''} disabled={!row.dep} onCommit={(value) => handleCellCommit(row.dep, 'counters', value)} />
                        </td>
```

- [ ] **Step 6: Run tests, lint, and build**

Run:

```powershell
cd app
npm run test:rules
npx eslint src/app/daily/page.tsx src/lib/dailySchedule.ts
npm run build
```

Expected: rule tests, targeted lint, and build pass.

- [ ] **Step 7: Commit**

Run:

```powershell
git add app/src/app/daily/page.tsx app/src/lib/dailySchedule.ts app/scripts/rule-regression-tests.cjs
git commit -m "feat: support daily schedule inline edits"
```

Expected: commit succeeds. If `git` is still unavailable, record the blocker and continue without committing.

---

### Task 4: Add, Delete, Link, and Unlink Operations

**Files:**
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/lib/dailySchedule.ts`

- [ ] **Step 1: Add selected record ID helper**

In `app/src/lib/dailySchedule.ts`, add:

```ts
export function getDailyRowRecordIds(row: DailyScheduleRow): string[] {
  return [row.arr?.id, row.dep?.id].filter((id): id is string => Boolean(id));
}
```

- [ ] **Step 2: Import operation helpers in Daily page**

In `app/src/app/daily/page.tsx`, add:

```tsx
import {
  addedModificationsToFlightRecords,
  applyModificationBatch,
  buildFlightRecordHistoryEntry,
} from '@/lib/detailedScheduleState';
import {
  assertNoDuplicateFlightNumbers,
  linkFlightRecordPairs,
  unlinkFlightRecords,
} from '@/lib/atomicSchedule';
import {
  applyLocalFlightRecordMutation,
  applyLocalModificationBatch,
  markDerivedSeasonalDirty,
  rebuildPendingOpsFromBaseline,
} from '@/lib/localSeasonStore';
import NewFlightModal from '../components/NewFlightModal';
import type { NewFlightDateSelection } from '@/lib/detailedScheduleState';
```

- [ ] **Step 3: Add Add Flight modal state and toolbar buttons**

Inside `DailyScheduleContent`, add:

```tsx
  const [isNewFlightOpen, setIsNewFlightOpen] = useState(false);
  const newFlightDateSelection = useMemo<NewFlightDateSelection>(() => ({
    kind: 'range',
    dates: [fromDateTime.slice(0, 10), toDateTime.slice(0, 10)],
  }), [fromDateTime, toDateTime]);
```

In the toolbar, before the summary metrics, add:

```tsx
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setIsNewFlightOpen(true)} className="px-2 py-1.5 border border-outline-variant rounded text-sm hover:bg-surface-container-low" title="Add flight">
                <span className="material-symbols-outlined text-[18px]">add</span>
              </button>
              <button type="button" onClick={handleLinkSelected} className="px-2 py-1.5 border border-outline-variant rounded text-sm hover:bg-surface-container-low" title="Link selected">
                <span className="material-symbols-outlined text-[18px]">link</span>
              </button>
              <button type="button" onClick={handleUnlinkSelected} className="px-2 py-1.5 border border-outline-variant rounded text-sm hover:bg-surface-container-low" title="Unlink selected">
                <span className="material-symbols-outlined text-[18px]">link_off</span>
              </button>
              <button type="button" onClick={handleDeleteSelected} className="px-2 py-1.5 border border-error/50 text-error rounded text-sm hover:bg-error-container" title="Delete selected">
                <span className="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
```

Render `NewFlightModal` near `{dialogNode}`:

```tsx
      <NewFlightModal
        isOpen={isNewFlightOpen}
        onClose={() => setIsNewFlightOpen(false)}
        mode="detailed"
        prefillDateSelection={newFlightDateSelection}
        onSubmitDetailed={handleAddFlights}
      />
```

- [ ] **Step 4: Add operation handlers**

Inside `DailyScheduleContent`, add:

```tsx
  const selectedRows = useMemo(() => visibleRows.filter((row) => selectedIds.has(row.id)), [selectedIds, visibleRows]);

  const selectedRecordIds = useMemo(() => (
    selectedRows.flatMap((row) => [row.arr?.id, row.dep?.id].filter((id): id is string => Boolean(id)))
  ), [selectedRows]);

  const handleAddFlights = async (mods: FlightModification[]) => {
    if (!season) return;
    const addedRecords = addedModificationsToFlightRecords(mods.filter((mod) => mod.action === 'added'));
    assertNoDuplicateFlightNumbers([...records, ...addedRecords]);
    const workspace = await loadLocalSeasonWorkspace(season.id);
    if (!workspace) throw new Error('Local workspace not found');
    const timestamp = Date.now();
    const nextRecords = [
      ...workspace.records.filter((record) => !addedRecords.some((added) => added.id === record.id)),
      ...addedRecords,
    ];
    const historyEntry: ModHistoryEntry = {
      id: `LOCAL_DAILY_ADD_${timestamp}`,
      timestamp,
      description: `Daily added ${addedRecords.length} flight(s)`,
      changes: [],
      recordChanges: addedRecords.map((record) => ({
        recordId: record.id,
        previousRecord: null,
        newRecord: record,
      })),
    };
    const nextWorkspace = markDerivedSeasonalDirty(
      rebuildPendingOpsFromBaseline({
        ...workspace,
        records: nextRecords,
        modHistory: [historyEntry, ...workspace.modHistory],
      }, timestamp)
    );
    await saveLocalSeasonWorkspace(nextWorkspace);
    setRecords(nextWorkspace.records);
    setModHistory(nextWorkspace.modHistory);
    setSyncSummary({
      pendingCount: nextWorkspace.syncMeta.pendingCount,
      lastLocalChangeAt: nextWorkspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, { records: nextWorkspace.records });
  };

  const handleDeleteSelected = async () => {
    if (!season || selectedRecordIds.length === 0) return;
    const mods = selectedRecordIds.map((legId) => ({ legId, action: 'deleted' as const }));
    const timestamp = Date.now();
    const historyEntry: ModHistoryEntry = {
      id: `LOCAL_DAILY_DELETE_${timestamp}`,
      timestamp,
      description: `Daily deleted ${mods.length} flight(s)`,
      changes: mods.map((mod) => ({
        legId: mod.legId,
        previousMod: modifications.get(mod.legId) ?? null,
        newMod: mod,
      })),
    };
    const workspace = await applyLocalModificationBatch(season.id, mods, historyEntry);
    setModifications(workspace.modifications);
    setModHistory(workspace.modHistory);
    setSelectedIds(new Set());
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, { modifications: workspace.modifications });
  };

  const handleLinkSelected = async () => {
    if (!season) return;
    const selectedRecords = records.filter((record) => selectedRecordIds.includes(record.id) && record.status !== 'deleted');
    const arrIds = selectedRecords.filter((record) => record.type === 'A').map((record) => record.id);
    const depIds = selectedRecords.filter((record) => record.type === 'D').map((record) => record.id);
    if (arrIds.length === 0 || depIds.length === 0 || arrIds.length !== depIds.length) {
      throw new Error('Select matching ARR and DEP records to link.');
    }
    const arrSample = selectedRecords.find((record) => record.type === 'A');
    const depSample = selectedRecords.find((record) => record.type === 'D');
    const linkType = arrSample && depSample && depSample.schedule < arrSample.schedule ? 'overnight' as const : 'sameday' as const;
    const result = linkFlightRecordPairs(records, arrIds, depIds, linkType);
    const timestamp = Date.now();
    const historyEntry = buildFlightRecordHistoryEntry({
      id: `LOCAL_DAILY_LINK_${timestamp}`,
      timestamp,
      description: `Daily linked ${result.updatedRecords.length} flight(s)`,
      beforeRecords: records,
      afterRecords: result.records,
    });
    const workspace = await applyLocalFlightRecordMutation(season.id, result, historyEntry ?? undefined);
    setRecords(workspace.records);
    setModHistory(workspace.modHistory);
    setSelectedIds(new Set());
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, { records: workspace.records });
  };

  const handleUnlinkSelected = async () => {
    if (!season || selectedRecordIds.length === 0) return;
    const result = unlinkFlightRecords(records, selectedRecordIds);
    const timestamp = Date.now();
    const historyEntry = buildFlightRecordHistoryEntry({
      id: `LOCAL_DAILY_UNLINK_${timestamp}`,
      timestamp,
      description: `Daily unlinked ${result.updatedRecords.length} flight(s)`,
      beforeRecords: records,
      afterRecords: result.records,
    });
    const workspace = await applyLocalFlightRecordMutation(season.id, result, historyEntry ?? undefined);
    setRecords(workspace.records);
    setModHistory(workspace.modHistory);
    setSelectedIds(new Set());
    setSyncSummary({
      pendingCount: workspace.syncMeta.pendingCount,
      lastLocalChangeAt: workspace.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, { records: workspace.records });
  };
```

Wrap operation calls from buttons with `try/catch` if the handler is not already catching, using:

```tsx
void showAlert({ title: 'Daily Schedule Action Failed', message: (err as Error).message, tone: 'error' });
```

- [ ] **Step 5: Run focused verification**

Run:

```powershell
cd app
npm run test:rules
npx eslint src/app/daily/page.tsx src/lib/dailySchedule.ts
npm run build
```

Expected: tests, lint, and build pass. Fix TypeScript issues from `FlightLeg` versus `FlightRecord` by keeping selected operation IDs mapped against canonical `records`, not row leg objects.

- [ ] **Step 6: Commit**

Run:

```powershell
git add app/src/app/daily/page.tsx app/src/lib/dailySchedule.ts
git commit -m "feat: add daily schedule row operations"
```

Expected: commit succeeds. If `git` is still unavailable, record the blocker and continue without committing.

---

### Task 5: Documentation, Polish, and Final Verification

**Files:**
- Modify: `context.md`
- Modify: `app/src/app/daily/page.tsx`

- [ ] **Step 1: Document Daily Schedule in `context.md`**

Add this section under `## UI Rules` in `context.md`:

```md
### Daily Schedule

- Daily Schedule is a date/time-range operational grid over canonical `flightRecords` plus local modification overlays.
- The `From` and `To` datetime inputs default the time portion to `05:00` only as a user convenience. The filter uses each record's actual `date + STA/STD`; early-morning flights are not reassigned to the previous operational day unless the selected range includes them.
- The toolbar summary shows `ARR`, `DEP`, and `TOTAL` counts for records included by the selected datetime range.
- Linked ARR/DEP records are consolidated into one visible row only as a display projection. `FlightRecord` remains the editable/exportable truth.
- All supported fields are edited directly in the grid. Edits write IndexedDB/local workspace first, update local React/cache state, and wait for the manual Sync button before Firestore writes.
- Daily Schedule must not use a turnaround details side panel, native browser dialogs, direct Firestore writes during normal edits, `window.location.reload()`, or full-season refetches after local mutations.
```

- [ ] **Step 2: Add empty and no-season states**

In `app/src/app/daily/page.tsx`, inside `<main>`, before the table section, add:

```tsx
          {!loading && !season && (
            <div className="p-8 text-center bg-surface-container-lowest border border-outline-variant rounded-lg text-on-surface-variant">
              No season available. Import a seasonal schedule first.
            </div>
          )}
```

Inside the table body, after `visibleRows.map(...)`, add:

```tsx
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={COLUMNS.length + 2} className="p-8 text-center text-on-surface-variant">
                          No flights inside the selected datetime range.
                        </td>
                      </tr>
                    )}
```

- [ ] **Step 3: Search for forbidden Daily Schedule patterns**

Run:

```powershell
Select-String -Path app/src/app/daily/page.tsx -Pattern 'window.location.reload','alert(','confirm(','batchWrite','updateSeason','createSeason'
```

Expected: no matches for forbidden direct mutation/reload/native dialog patterns.

- [ ] **Step 4: Run final verification**

Run:

```powershell
cd app
npm run test:rules
npx eslint src/app/daily/page.tsx src/app/page.tsx src/app/detailed/page.tsx src/lib/dailySchedule.ts
npm run build
```

Expected:

- `npm run test:rules` passes.
- Targeted ESLint passes for touched files.
- `npm run build` passes.

- [ ] **Step 5: Commit**

Run:

```powershell
git add context.md app/src/app/daily/page.tsx
git commit -m "docs: document daily schedule behavior"
```

Expected: commit succeeds. If `git` is still unavailable, record the blocker in the final handoff.
