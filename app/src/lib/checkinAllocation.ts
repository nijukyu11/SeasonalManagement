import {
  buildCheckInBhsValue,
  buildCheckInCounterResources,
  buildCheckInCounterSections,
  findCheckInLockConflict,
} from './checkInCounterSettings';
import { evaluateCounterRules, validateOperationalSettings } from './settingsRules';
import type { AirlineColorSetting, CheckInAllocationMode, CheckInCounterWindowMap, FlightCounter, FlightModification, FlightRecord, OperationalSettings } from './types';
import type { CheckInCounterResourceRow, CheckInCounterResourceSection, CheckInLockConflict } from './checkInCounterSettings';

export const CHECKIN_SNAP_MINUTES = 15;
export const CHECKIN_RESIZE_SNAP_MINUTES = 1;

const DEFAULT_START_OFFSET_MINUTES = -180;
const DEFAULT_END_OFFSET_MINUTES = -50;
const DEFAULT_NUMERIC_COUNTER_COUNT = 20;
const DEFAULT_M_COUNTER_COUNT = 5;
const FULL_LABEL_MIN_WIDTH = 180;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const CHECKIN_COLOR_PALETTE = [
  { backgroundColor: '#dbeafe', borderColor: '#2563eb', textColor: '#172554', focusColor: 'rgba(37, 99, 235, 0.22)' },
  { backgroundColor: '#dcfce7', borderColor: '#16a34a', textColor: '#052e16', focusColor: 'rgba(22, 163, 74, 0.22)' },
  { backgroundColor: '#fef3c7', borderColor: '#d97706', textColor: '#451a03', focusColor: 'rgba(217, 119, 6, 0.22)' },
  { backgroundColor: '#fae8ff', borderColor: '#c026d3', textColor: '#4a044e', focusColor: 'rgba(192, 38, 211, 0.22)' },
  { backgroundColor: '#ccfbf1', borderColor: '#0d9488', textColor: '#042f2e', focusColor: 'rgba(13, 148, 136, 0.22)' },
  { backgroundColor: '#ffe4e6', borderColor: '#e11d48', textColor: '#4c0519', focusColor: 'rgba(225, 29, 72, 0.22)' },
  { backgroundColor: '#ede9fe', borderColor: '#7c3aed', textColor: '#2e1065', focusColor: 'rgba(124, 58, 237, 0.22)' },
  { backgroundColor: '#e0f2fe', borderColor: '#0284c7', textColor: '#082f49', focusColor: 'rgba(2, 132, 199, 0.22)' },
  { backgroundColor: '#f5f5f4', borderColor: '#57534e', textColor: '#1c1917', focusColor: 'rgba(87, 83, 78, 0.22)' },
  { backgroundColor: '#ffedd5', borderColor: '#ea580c', textColor: '#431407', focusColor: 'rgba(234, 88, 12, 0.22)' },
] as const;

export type CheckInCounter = string | number;
export type CheckInLabelMode = 'full' | 'compact' | 'flightOnly';

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
  stackIndex: number;
  stackLaneCount: number;
  bhs: string | null;
  lockConflict: CheckInLockConflict | null;
}

export interface CheckInAllocationView {
  roster: CheckInCounter[];
  resourceRows: CheckInCounterResourceRow[];
  resourceSections: CheckInCounterResourceSection[];
  unallocated: CheckInFlightItem[];
  resourceBars: CheckInResourceBar[];
}

export interface CheckInRecordProjection {
  recordId: string;
  unallocated: CheckInFlightItem[];
  resourceBars: CheckInResourceBar[];
}

export interface CheckInColorToken {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  focusColor: string;
}

export interface CheckInPackedItem extends CheckInFlightItem {
  laneIndex: number;
  leftPercent: number;
  widthPercent: number;
}

export interface CheckInPackedRows {
  laneCount: number;
  items: CheckInPackedItem[];
}

export interface CheckInEdgeScrollInput {
  pointerX: number;
  pointerY: number;
  rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  threshold?: number;
  maxSpeed?: number;
}

export interface CheckInResizePreview {
  minuteDelta: number;
  markerX: number;
  time: string;
  label: string;
}

interface AllocationContext {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}

interface ConflictContext extends AllocationContext {
  proposedRecordId: string;
  proposedCounters: CheckInCounter[];
  proposedWindow: CheckInWindow;
}

interface CheckInResourceContextInput {
  settings?: OperationalSettings;
  resources?: CheckInCounterResourceRow[];
  assignedCounters: CheckInCounter[];
  groupByCounterGroup?: boolean;
  visibleWindow?: CheckInWindow | null;
}

interface CheckInResourceContext {
  resources: CheckInCounterResourceRow[] | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function parseLocalDateTime(value: string): Date {
  const match = LOCAL_DATETIME_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid local datetime ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`Invalid local datetime ${value}`);
  }
  return date;
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function recordStdDateTime(record: Pick<FlightRecord, 'date' | 'schedule'>): string {
  return `${record.date}T${record.schedule}`;
}

function addMinutes(value: string, minutes: number): string {
  const date = parseLocalDateTime(value);
  date.setMinutes(date.getMinutes() + minutes);
  return formatLocalDateTime(date);
}

function minutesBetween(left: string, right: string): number {
  return (parseLocalDateTime(right).getTime() - parseLocalDateTime(left).getTime()) / 60000;
}

function assertWindow(window: CheckInWindow): void {
  if (parseLocalDateTime(window.start).getTime() >= parseLocalDateTime(window.end).getTime()) {
    throw new Error('Check-in start must be before check-in end.');
  }
}

function assertTimelineRange(from: string, to: string): void {
  if (parseLocalDateTime(from).getTime() >= parseLocalDateTime(to).getTime()) {
    throw new Error('Timeline start must be before end.');
  }
}

function laterDateTime(left: string, right: string): string {
  return parseLocalDateTime(left).getTime() >= parseLocalDateTime(right).getTime() ? left : right;
}

function earlierDateTime(left: string, right: string): string {
  return parseLocalDateTime(left).getTime() <= parseLocalDateTime(right).getTime() ? left : right;
}

function snapMinutes(minutes: number): number {
  return Math.round(minutes / CHECKIN_SNAP_MINUTES) * CHECKIN_SNAP_MINUTES;
}

function snapResizeMinutes(minutes: number): number {
  return Math.round(minutes / CHECKIN_RESIZE_SNAP_MINUTES) * CHECKIN_RESIZE_SNAP_MINUTES;
}

export function buildCheckInResizePreview({
  anchorX,
  anchorTime,
  startClientX,
  clientX,
  pixelsPerMinute,
  timelineWidth,
}: {
  edge: 'start' | 'end';
  anchorX: number;
  anchorTime: string;
  startClientX: number;
  clientX: number;
  pixelsPerMinute: number;
  timelineWidth: number;
}): CheckInResizePreview {
  const minuteDelta = snapResizeMinutes((clientX - startClientX) / pixelsPerMinute);
  const markerX = Math.max(0, Math.min(timelineWidth, anchorX + minuteDelta * pixelsPerMinute));
  const time = addMinutes(anchorTime, minuteDelta);
  return {
    minuteDelta,
    markerX,
    time,
    label: formatCheckInDisplayTime(time),
  };
}

function counterKey(counter: CheckInCounter): string {
  return typeof counter === 'number' ? `N:${counter}` : `S:${counter.toUpperCase()}`;
}

function normalizeCounterToken(value: unknown): CheckInCounter | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  return text.toUpperCase();
}

function addCounterUnique(counters: CheckInCounter[], seen: Set<string>, counter: CheckInCounter | null): void {
  if (counter == null) return;
  const key = counterKey(counter);
  if (seen.has(key)) return;
  seen.add(key);
  counters.push(counter);
}

function collectCounterValues(value: unknown, counters: CheckInCounter[], seen: Set<string>): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCounterValues(item, counters, seen);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectCounterValues(item, counters, seen);
    return;
  }
  if (typeof value === 'string') {
    for (const rawPart of value.split(/[,\s;]+/)) {
      const part = rawPart.trim();
      const numericRange = /^(\d+)-(\d+)$/.exec(part);
      if (numericRange) {
        const start = Number(numericRange[1]);
        const end = Number(numericRange[2]);
        const step = start <= end ? 1 : -1;
        for (let current = start; current !== end + step; current += step) {
          addCounterUnique(counters, seen, current);
        }
      } else {
        addCounterUnique(counters, seen, normalizeCounterToken(part));
      }
    }
    return;
  }
  addCounterUnique(counters, seen, normalizeCounterToken(value));
}

function collectAssignedCounters(records: Array<Pick<FlightRecord, 'counter'>>, extraCounters: CheckInCounter[] = []): CheckInCounter[] {
  const counters: CheckInCounter[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const counter of normalizeCheckInCounterList(record.counter)) {
      addCounterUnique(counters, seen, counter);
    }
  }
  for (const counter of extraCounters) {
    addCounterUnique(counters, seen, counter);
  }
  return counters;
}

function hasConfiguredResources(settings: OperationalSettings | undefined): boolean {
  return (settings?.checkInCounters?.length ?? 0) > 0;
}

function buildResourceContext({
  settings,
  resources,
  assignedCounters,
  groupByCounterGroup = false,
  visibleWindow = null,
}: CheckInResourceContextInput): CheckInResourceContext {
  if (resources) return { resources };
  if (!settings || !hasConfiguredResources(settings)) return { resources: null };
  return {
    resources: buildCheckInCounterResources({
      settings,
      assignedCounters,
      groupByCounterGroup,
      visibleWindow,
    }),
  };
}

function settingsBackedResources(resources: CheckInCounterResourceRow[] | null): CheckInCounterResourceRow[] | null {
  if (!resources?.some((resource) => !resource.isLegacy)) return null;
  return resources;
}

function buildDerivedBhsPatch(resources: CheckInCounterResourceRow[] | null, counters: CheckInCounter[]): Pick<FlightModification, 'bhs'> | Record<string, never> {
  const settingsResources = settingsBackedResources(resources);
  if (!settingsResources) return {};
  return {
    bhs: buildCheckInBhsValue(counters, settingsResources),
  };
}

function cloneCounterWindows(value: CheckInCounterWindowMap | null | undefined): CheckInCounterWindowMap {
  const windows: CheckInCounterWindowMap = {};
  for (const [key, window] of Object.entries(value ?? {})) {
    windows[key] = { start: window.start, end: window.end };
  }
  return windows;
}

function buildCounterWindowMap(counters: CheckInCounter[], window: CheckInWindow): CheckInCounterWindowMap {
  const windows: CheckInCounterWindowMap = {};
  for (const counter of counters) {
    windows[counterKey(counter)] = { ...window };
  }
  return windows;
}

function ensureCounterWindowMap(
  record: Pick<FlightRecord, 'date' | 'schedule' | 'checkInStart' | 'checkInEnd' | 'checkInCounterWindows'>,
  counters: CheckInCounter[]
): CheckInCounterWindowMap {
  const sharedWindow = buildCheckInWindow(record);
  const windows = cloneCounterWindows(record.checkInCounterWindows);
  for (const counter of counters) {
    const key = counterKey(counter);
    windows[key] = windows[key] ?? { ...sharedWindow };
  }
  return windows;
}

function compactCounterWindowMap(windows: CheckInCounterWindowMap, counters: CheckInCounter[]): CheckInCounterWindowMap {
  const compacted: CheckInCounterWindowMap = {};
  for (const counter of counters) {
    const key = counterKey(counter);
    if (windows[key]) compacted[key] = windows[key];
  }
  return compacted;
}

function compareCounters(left: CheckInCounter, right: CheckInCounter): number {
  const leftNumber = typeof left === 'number';
  const rightNumber = typeof right === 'number';
  if (leftNumber && rightNumber) return left - right;
  if (leftNumber) return -1;
  if (rightNumber) return 1;

  const leftMatch = /^([A-Z]+)(\d+)$/.exec(left);
  const rightMatch = /^([A-Z]+)(\d+)$/.exec(right);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    return Number(leftMatch[2]) - Number(rightMatch[2]);
  }
  return left.localeCompare(right);
}

function areCountersContiguous(counters: CheckInCounter[], roster: CheckInCounter[]): boolean {
  if (counters.length <= 1) return true;
  const indexes = counters.map((counter) => roster.findIndex((item) => counterKey(item) === counterKey(counter))).sort((a, b) => a - b);
  return indexes.every((index, position) => index >= 0 && (position === 0 || index === indexes[position - 1] + 1));
}

function applyRecordModification(record: FlightRecord, mod: FlightModification | undefined): FlightRecord | null {
  if (!mod) return record;
  if (mod.action === 'deleted') return null;
  if (mod.action === 'added' && mod.addedLeg) return { ...record, ...mod.addedLeg } as FlightRecord;
  return {
    ...record,
    schedule: 'schedule' in mod && mod.schedule != null ? mod.schedule : record.schedule,
    aircraft: 'aircraft' in mod && mod.aircraft != null ? mod.aircraft : record.aircraft,
    route: 'route' in mod && mod.route != null ? mod.route : record.route,
    codeShares: 'codeShares' in mod ? mod.codeShares ?? null : record.codeShares,
    pax: 'pax' in mod ? mod.pax ?? null : record.pax,
    gate: 'gate' in mod ? mod.gate ?? null : record.gate,
    stand: 'stand' in mod ? mod.stand ?? null : record.stand,
    counter: 'counter' in mod ? mod.counter ?? null : record.counter,
    carousel: 'carousel' in mod ? mod.carousel ?? null : record.carousel,
    mct: 'mct' in mod ? mod.mct ?? null : record.mct,
    fb: 'fb' in mod ? mod.fb ?? null : record.fb,
    lb: 'lb' in mod ? mod.lb ?? null : record.lb,
    bhs: 'bhs' in mod ? mod.bhs ?? null : record.bhs,
    ghs: 'ghs' in mod ? mod.ghs ?? null : record.ghs,
    checkInStart: 'checkInStart' in mod ? mod.checkInStart ?? null : record.checkInStart ?? null,
    checkInEnd: 'checkInEnd' in mod ? mod.checkInEnd ?? null : record.checkInEnd ?? null,
    checkInAllocationMode: 'checkInAllocationMode' in mod ? mod.checkInAllocationMode ?? null : record.checkInAllocationMode ?? null,
    checkInCounterWindows: 'checkInCounterWindows' in mod ? mod.checkInCounterWindows ?? null : record.checkInCounterWindows ?? null,
  };
}

function buildModification(record: FlightRecord, patch: Partial<FlightModification>): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    ...patch,
  };
}

function buildRosterIndexes(roster: CheckInCounter[]): Map<string, number> {
  const indexes = new Map<string, number>();
  roster.forEach((counter, index) => indexes.set(counterKey(counter), index));
  return indexes;
}

function findCounterIndex(roster: CheckInCounter[], counter: CheckInCounter): number {
  return roster.findIndex((item) => counterKey(item) === counterKey(counter));
}

function windowOverlaps(left: CheckInWindow, right: CheckInWindow): boolean {
  return parseLocalDateTime(left.start).getTime() < parseLocalDateTime(right.end).getTime() &&
    parseLocalDateTime(right.start).getTime() < parseLocalDateTime(left.end).getTime();
}

function validateCountersInRoster(counters: CheckInCounter[], roster: CheckInCounter[]): void {
  const rosterKeys = new Set(roster.map(counterKey));
  for (const counter of counters) {
    if (!rosterKeys.has(counterKey(counter))) {
      throw new Error(`Counter ${displayCheckInCounter(counter)} is not in the counter roster.`);
    }
  }
}

function validateNoConflicts(context: ConflictContext): void {
  assertWindow(context.proposedWindow);
}

function validateResourceLocks({
  counters,
  window,
  resources,
}: {
  counters: CheckInCounter[];
  window: CheckInWindow;
  resources: CheckInCounterResourceRow[] | null;
}): void {
  if (!resources) return;
  const conflict = findCheckInLockConflict(counters, window, resources);
  if (!conflict) return;
  const reason = conflict.lock.reason ? ` (${conflict.lock.reason})` : '';
  throw new Error(
    `Counter ${displayCheckInCounter(conflict.counter)} is locked by ${conflict.lock.name} from ${conflict.lock.start} to ${conflict.lock.end}${reason}.`
  );
}

function buildMovedCounters(currentCounters: CheckInCounter[], roster: CheckInCounter[], rowDelta: number): CheckInCounter[] {
  const indexes = currentCounters.map((counter) => findCounterIndex(roster, counter));
  if (indexes.some((index) => index < 0)) throw new Error('Current counter is not in the counter roster.');
  const nextIndexes = indexes.map((index) => index + rowDelta);
  if (nextIndexes.some((index) => index < 0 || index >= roster.length)) {
    throw new Error('Check-in allocation cannot move outside the counter roster.');
  }
  return nextIndexes.map((index) => roster[index]);
}

function buildMovedSingleCounter(currentCounters: CheckInCounter[], roster: CheckInCounter[], counter: CheckInCounter, rowDelta: number): CheckInCounter[] {
  const currentIndex = currentCounters.findIndex((item) => counterKey(item) === counterKey(counter));
  if (currentIndex < 0) throw new Error('Selected counter is not assigned to this check-in allocation.');
  const rosterIndex = findCounterIndex(roster, currentCounters[currentIndex]);
  if (rosterIndex < 0) throw new Error('Current counter is not in the counter roster.');
  const nextRosterIndex = rosterIndex + rowDelta;
  if (nextRosterIndex < 0 || nextRosterIndex >= roster.length) {
    throw new Error('Check-in allocation cannot move outside the counter roster.');
  }
  const nextCounter = roster[nextRosterIndex];
  const nextKey = counterKey(nextCounter);
  if (currentCounters.some((item, index) => index !== currentIndex && counterKey(item) === nextKey)) {
    throw new Error(`Counter ${displayCheckInCounter(nextCounter)} is already assigned to this check-in allocation.`);
  }
  return currentCounters.map((item, index) => index === currentIndex ? nextCounter : item);
}

function buildContiguousCountersFromLowest(currentCounters: CheckInCounter[], roster: CheckInCounter[]): CheckInCounter[] {
  if (currentCounters.length === 0) throw new Error('Cannot reshape an unallocated check-in record.');
  if (currentCounters.length > roster.length) throw new Error('Not enough counter rows are available to reshape this allocation.');
  const indexes = currentCounters.map((counter) => findCounterIndex(roster, counter)).sort((a, b) => a - b);
  if (indexes.some((index) => index < 0)) throw new Error('Current counter is not in the counter roster.');
  const startIndex = Math.min(indexes[0], roster.length - currentCounters.length);
  return roster.slice(startIndex, startIndex + currentCounters.length);
}

function buildEffectiveRecord(record: FlightRecord, modifications: Map<string, FlightModification>): FlightRecord | null {
  return applyRecordModification(record, modifications.get(record.id));
}

function sortUnallocatedCheckInFlights(unallocated: CheckInFlightItem[]): void {
  unallocated.sort((left, right) =>
    left.window.start.localeCompare(right.window.start) ||
    recordStdDateTime(left.record).localeCompare(recordStdDateTime(right.record)) ||
    formatCheckInFlightLabel(left.record).localeCompare(formatCheckInFlightLabel(right.record))
  );
}

function sortCheckInResourceBars(resourceBars: CheckInResourceBar[]): void {
  resourceBars.sort((left, right) => left.counterIndex - right.counterIndex || left.start.localeCompare(right.start) || left.flightNumber.localeCompare(right.flightNumber));
}

function assignResourceBarStacks(resourceBars: CheckInResourceBar[], onlyCounterKeys?: Set<string>): void {
  const barsByCounter = new Map<string, CheckInResourceBar[]>();
  for (const bar of resourceBars) {
    const key = counterKey(bar.counter);
    if (onlyCounterKeys && !onlyCounterKeys.has(key)) continue;
    bar.stackIndex = 0;
    bar.stackLaneCount = 1;
    const bars = barsByCounter.get(key) ?? [];
    bars.push(bar);
    barsByCounter.set(key, bars);
  }

  for (const bars of barsByCounter.values()) {
    const laneEnds: string[] = [];
    const sorted = [...bars].sort((left, right) =>
      left.start.localeCompare(right.start) ||
      left.end.localeCompare(right.end) ||
      left.flightNumber.localeCompare(right.flightNumber)
    );
    for (const bar of sorted) {
      const laneIndex = laneEnds.findIndex((end) => parseLocalDateTime(end).getTime() <= parseLocalDateTime(bar.start).getTime());
      const resolvedLane = laneIndex >= 0 ? laneIndex : laneEnds.length;
      laneEnds[resolvedLane] = bar.end;
      bar.stackIndex = resolvedLane;
    }
    const laneCount = Math.max(1, laneEnds.length);
    for (const bar of bars) {
      bar.stackLaneCount = laneCount;
    }
  }
}

export function formatCheckInFlightLabel(record: Pick<FlightRecord, 'airline' | 'flightNumber' | 'rawFlightNumber'>): string {
  const airline = String(record.airline ?? '').trim().toUpperCase();
  const rawFlightNumber = String(record.rawFlightNumber ?? '').trim().toUpperCase();
  const fallbackFlightNumber = String(record.flightNumber ?? '').trim().toUpperCase();
  const rawNumber = rawFlightNumber.startsWith(airline)
    ? rawFlightNumber.slice(airline.length)
    : rawFlightNumber || (fallbackFlightNumber.startsWith(airline) ? fallbackFlightNumber.slice(airline.length) : fallbackFlightNumber);
  const normalizedNumber = /^\d+$/.test(rawNumber) && rawNumber.length < 3 ? rawNumber.padStart(3, '0') : rawNumber.toUpperCase();
  if (airline && normalizedNumber) return `${airline}${normalizedNumber}`;
  return fallbackFlightNumber;
}

export function displayCheckInCounter(counter: CheckInCounter): string {
  return String(counter);
}

export function formatCheckInDisplayTime(value: string): string {
  const date = parseLocalDateTime(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function buildDefaultCheckInWindow(record: Pick<FlightRecord, 'date' | 'schedule' | 'checkInStart' | 'checkInEnd'>): CheckInWindow {
  const defaultStart = addMinutes(recordStdDateTime(record), DEFAULT_START_OFFSET_MINUTES);
  const defaultEnd = addMinutes(recordStdDateTime(record), DEFAULT_END_OFFSET_MINUTES);
  const window = {
    start: record.checkInStart ?? defaultStart,
    end: record.checkInEnd ?? defaultEnd,
  };
  assertWindow(window);
  return window;
}

export function buildCheckInWindow(record: Pick<FlightRecord, 'date' | 'schedule' | 'checkInStart' | 'checkInEnd'>): CheckInWindow {
  return buildDefaultCheckInWindow(record);
}

export function buildCheckInCounterWindow(
  record: Pick<FlightRecord, 'date' | 'schedule' | 'checkInStart' | 'checkInEnd' | 'checkInAllocationMode' | 'checkInCounterWindows'>,
  counter: CheckInCounter
): CheckInWindow {
  const sharedWindow = buildCheckInWindow(record);
  if (record.checkInAllocationMode !== 'broken') return sharedWindow;
  const counterWindow = record.checkInCounterWindows?.[counterKey(counter)];
  if (!counterWindow) return sharedWindow;
  assertWindow(counterWindow);
  return { ...counterWindow };
}

export function normalizeCheckInCounterList(value: FlightCounter | CheckInCounter[] | CheckInCounter | undefined): CheckInCounter[] {
  const counters: CheckInCounter[] = [];
  collectCounterValues(value, counters, new Set<string>());
  return counters;
}

export function validateCheckInAllocationConflicts({
  record,
  counters,
  window,
  records,
  modifications,
  settings,
  resources,
}: {
  record: FlightRecord;
  counters: CheckInCounter[];
  window: CheckInWindow;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings?: OperationalSettings;
  resources?: CheckInCounterResourceRow[];
}): void {
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,
    proposedCounters: counters,
    proposedWindow: window,
  });
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateResourceLocks({ counters, window, resources: resourceContext.resources });
}

export function buildDefaultCounterRoster(records: Array<Pick<FlightRecord, 'counter'>>): CheckInCounter[] {
  const counters: CheckInCounter[] = [];
  const seen = new Set<string>();
  for (let counter = 1; counter <= DEFAULT_NUMERIC_COUNTER_COUNT; counter += 1) {
    addCounterUnique(counters, seen, counter);
  }
  for (let counter = 1; counter <= DEFAULT_M_COUNTER_COUNT; counter += 1) {
    addCounterUnique(counters, seen, `M${counter}`);
  }
  for (const record of records) {
    for (const counter of normalizeCheckInCounterList(record.counter)) {
      addCounterUnique(counters, seen, counter);
    }
  }
  return counters.sort(compareCounters);
}

export function getRequiredCheckInCounters(record: FlightRecord, settings: OperationalSettings): { requiredCounters: number; ruleName: string } {
  const explicit = Number((record as FlightRecord & { requiredCounters?: unknown }).requiredCounters);
  if (Number.isInteger(explicit) && explicit > 0) return { requiredCounters: explicit, ruleName: 'Record override' };
  const evaluated = evaluateCounterRules(record, validateOperationalSettings(settings));
  return {
    requiredCounters: evaluated.counterValue ?? 1,
    ruleName: evaluated.rule?.name ?? 'Default',
  };
}

export function chooseCheckInLabelMode(widthPixels: number): CheckInLabelMode {
  if (widthPixels >= FULL_LABEL_MIN_WIDTH) return 'full';
  if (widthPixels >= 110) return 'compact';
  return 'flightOnly';
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function contrastTextColor(hexColor: string): string {
  const match = /^#?([0-9A-Fa-f]{6})$/.exec(hexColor.trim());
  if (!match) return '#FFFFFF';
  const value = match[1];
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance >= 150 ? '#0F172A' : '#FFFFFF';
}

function normalizeAirlineColorLookup(settings?: Pick<OperationalSettings, 'airlineColors'> | { airlineColors?: AirlineColorSetting[] } | null): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const setting of settings?.airlineColors ?? []) {
    const airlineCode = String(setting.airlineCode ?? '').trim().toUpperCase();
    const color = String(setting.color ?? '').trim().toUpperCase();
    if (!airlineCode || !/^#[0-9A-F]{6}$/.test(color)) continue;
    lookup.set(airlineCode, color);
  }
  return lookup;
}

export function getCheckInColorToken(
  record: Pick<FlightRecord, 'airline' | 'flightNumber' | 'rawFlightNumber'>,
  settings?: Pick<OperationalSettings, 'airlineColors'> | { airlineColors?: AirlineColorSetting[] } | null
): CheckInColorToken {
  const airline = String(record.airline ?? '').trim().toUpperCase();
  const configuredColor = normalizeAirlineColorLookup(settings).get(airline);
  if (configuredColor) {
    return {
      backgroundColor: configuredColor,
      borderColor: configuredColor,
      textColor: contrastTextColor(configuredColor),
      focusColor: configuredColor,
    };
  }
  const key = airline || formatCheckInFlightLabel(record);
  return CHECKIN_COLOR_PALETTE[hashText(key) % CHECKIN_COLOR_PALETTE.length];
}

export function buildCheckInPackedRows(items: CheckInFlightItem[], from: string, to: string): CheckInPackedRows {
  assertTimelineRange(from, to);
  const timelineWindow = { start: from, end: to };
  const totalMinutes = minutesBetween(from, to);
  const laneEnds: string[] = [];
  const packed = [...items]
    .filter((item) => windowOverlaps(item.window, timelineWindow))
    .sort((left, right) =>
      left.window.start.localeCompare(right.window.start) ||
      recordStdDateTime(left.record).localeCompare(recordStdDateTime(right.record)) ||
      formatCheckInFlightLabel(left.record).localeCompare(formatCheckInFlightLabel(right.record))
    )
    .map((item) => {
      const laneIndex = laneEnds.findIndex((end) => parseLocalDateTime(end).getTime() <= parseLocalDateTime(item.window.start).getTime());
      const resolvedLaneIndex = laneIndex >= 0 ? laneIndex : laneEnds.length;
      laneEnds[resolvedLaneIndex] = item.window.end;
      const visibleStart = laterDateTime(item.window.start, from);
      const visibleEnd = earlierDateTime(item.window.end, to);
      return {
        ...item,
        laneIndex: resolvedLaneIndex,
        leftPercent: (minutesBetween(from, visibleStart) / totalMinutes) * 100,
        widthPercent: (minutesBetween(visibleStart, visibleEnd) / totalMinutes) * 100,
      };
    });

  return {
    laneCount: laneEnds.length,
    items: packed,
  };
}

export function calculateCheckInEdgeScroll({
  pointerX,
  pointerY,
  rect,
  threshold = 56,
  maxSpeed = 28,
}: CheckInEdgeScrollInput): { x: number; y: number } {
  const axisSpeed = (distanceToStart: number, distanceToEnd: number): number => {
    if (distanceToStart < threshold) return -Math.ceil(((threshold - distanceToStart) / threshold) * maxSpeed);
    if (distanceToEnd < threshold) return Math.ceil(((threshold - distanceToEnd) / threshold) * maxSpeed);
    return 0;
  };
  return {
    x: axisSpeed(pointerX - rect.left, rect.right - pointerX),
    y: axisSpeed(pointerY - rect.top, rect.bottom - pointerY),
  };
}

export function buildCheckInTimelineTicks(from: string, to: string): CheckInTimelineTicks {
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  assertTimelineRange(from, to);
  const totalMinutes = minutesBetween(from, to);
  const minor: CheckInTimelineTick[] = [];
  const major: CheckInTimelineTick[] = [];
  const macro: CheckInTimelineTick[] = [];
  const seenMacroDays = new Set<string>();

  for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor.setMinutes(cursor.getMinutes() + CHECKIN_SNAP_MINUTES)) {
    const at = formatLocalDateTime(cursor);
    const leftPercent = totalMinutes === 0 ? 0 : (minutesBetween(from, at) / totalMinutes) * 100;
    minor.push({ at, label: formatCheckInDisplayTime(at), leftPercent });
    if (cursor.getMinutes() === 0) major.push({ at, label: formatCheckInDisplayTime(at), leftPercent });
    const dayKey = at.slice(0, 10);
    if (!seenMacroDays.has(dayKey)) {
      seenMacroDays.add(dayKey);
      macro.push({
        at,
        label: `${dayKey} ${cursor.toLocaleDateString('en-US', { weekday: 'short' })}`,
        leftPercent,
      });
    }
  }

  return { macro, major, minor };
}

export function buildCheckInRecordProjection({
  recordId,
  record,
  settings,
  from,
  to,
  roster,
  resourceRows,
  pixelsPerMinute,
}: {
  recordId: string;
  record: FlightRecord | null;
  settings: OperationalSettings;
  from: string;
  to: string;
  roster: CheckInCounter[];
  resourceRows: CheckInCounterResourceRow[];
  pixelsPerMinute: number;
}): CheckInRecordProjection {
  assertTimelineRange(from, to);
  const projection: CheckInRecordProjection = {
    recordId,
    unallocated: [],
    resourceBars: [],
  };
  if (!record || record.type !== 'D' || record.status === 'deleted') return projection;

  const timelineWindow = { start: from, end: to };
  const totalMinutes = minutesBetween(from, to);
  const sharedWindow = buildCheckInWindow(record);
  const counters = normalizeCheckInCounterList(record.counter);
  const demand = getRequiredCheckInCounters(record, settings);
  if (counters.length === 0) {
    if (windowOverlaps(sharedWindow, timelineWindow)) projection.unallocated.push({ record, window: sharedWindow, ...demand });
    return projection;
  }

  const rosterIndexes = buildRosterIndexes(roster);
  const settingsResources = settingsBackedResources(resourceRows);
  const mode = record.checkInAllocationMode ?? (areCountersContiguous(counters, roster) ? 'grouped' : 'broken');
  const bhs = settingsResources ? buildCheckInBhsValue(counters, settingsResources) : null;
  counters.forEach((counter) => {
    const counterIndex = rosterIndexes.get(counterKey(counter)) ?? -1;
    if (counterIndex < 0) return;
    const window = buildCheckInCounterWindow({ ...record, checkInAllocationMode: mode }, counter);
    if (!windowOverlaps(window, timelineWindow)) return;
    const visibleStart = laterDateTime(window.start, from);
    const visibleEnd = earlierDateTime(window.end, to);
    const leftPercent = (minutesBetween(from, visibleStart) / totalMinutes) * 100;
    const widthPercent = (minutesBetween(visibleStart, visibleEnd) / totalMinutes) * 100;
    const widthPixels = minutesBetween(visibleStart, visibleEnd) * pixelsPerMinute;
    const lockConflict = findCheckInLockConflict([counter], window, resourceRows);
    projection.resourceBars.push({
      id: `${record.id}:${displayCheckInCounter(counter)}`,
      recordId: record.id,
      groupId: record.id,
      counter,
      counterIndex,
      flightNumber: formatCheckInFlightLabel(record),
      mode,
      start: window.start,
      end: window.end,
      startLabel: formatCheckInDisplayTime(window.start),
      endLabel: formatCheckInDisplayTime(window.end),
      leftPercent,
      widthPercent,
      labelMode: chooseCheckInLabelMode(widthPixels),
      stackIndex: 0,
      stackLaneCount: 1,
      bhs,
      lockConflict,
    });
  });
  sortCheckInResourceBars(projection.resourceBars);
  assignResourceBarStacks(projection.resourceBars);
  return projection;
}

export function mergeCheckInAllocationViewPatch(
  view: CheckInAllocationView,
  patch: CheckInRecordProjection | CheckInRecordProjection[]
): CheckInAllocationView {
  const patches = Array.isArray(patch) ? patch : [patch];
  const patchedRecordIds = new Set(patches.map((item) => item.recordId));
  const affectedCounterKeys = new Set<string>();
  for (const bar of view.resourceBars) {
    if (patchedRecordIds.has(bar.recordId)) affectedCounterKeys.add(counterKey(bar.counter));
  }
  for (const item of patches) {
    for (const bar of item.resourceBars) affectedCounterKeys.add(counterKey(bar.counter));
  }

  const unallocated = view.unallocated.filter((item) => !patchedRecordIds.has(item.record.id));
  const resourceBars = view.resourceBars.filter((bar) => !patchedRecordIds.has(bar.recordId));
  for (const item of patches) {
    unallocated.push(...item.unallocated);
    resourceBars.push(...item.resourceBars);
  }
  sortUnallocatedCheckInFlights(unallocated);
  sortCheckInResourceBars(resourceBars);
  assignResourceBarStacks(resourceBars, affectedCounterKeys);
  return {
    ...view,
    unallocated,
    resourceBars,
  };
}

export function buildCheckInAllocationView({
  records,
  modifications,
  settings,
  from,
  to,
  roster,
  resources,
  groupByCounterGroup = false,
  pixelsPerMinute,
}: {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  from: string;
  to: string;
  roster?: CheckInCounter[];
  resources?: CheckInCounterResourceRow[];
  groupByCounterGroup?: boolean;
  pixelsPerMinute: number;
}): CheckInAllocationView {
  assertTimelineRange(from, to);
  const effectiveRecords = records
    .filter((record) => record.type === 'D' && record.status !== 'deleted')
    .map((record) => buildEffectiveRecord(record, modifications))
    .filter((record): record is FlightRecord => record != null);
  const timelineWindow = { start: from, end: to };
  const fallbackRoster = roster ?? buildDefaultCounterRoster(effectiveRecords);
  const resourceContext = buildResourceContext({
    settings,
    resources,
    assignedCounters: collectAssignedCounters(effectiveRecords),
    groupByCounterGroup,
    visibleWindow: timelineWindow,
  });
  const resourceRows = resourceContext.resources ?? buildCheckInCounterResources({
    settings,
    assignedCounters: fallbackRoster,
    groupByCounterGroup,
    visibleWindow: timelineWindow,
  });
  const resourceSections = buildCheckInCounterSections(resourceRows);
  const resolvedRoster = resourceContext.resources ? resourceRows.map((resource) => resource.counter) : fallbackRoster;
  const unallocated: CheckInFlightItem[] = [];
  const resourceBars: CheckInResourceBar[] = [];

  for (const record of effectiveRecords) {
    const projection = buildCheckInRecordProjection({
      recordId: record.id,
      record,
      settings,
      from,
      to,
      roster: resolvedRoster,
      resourceRows,
      pixelsPerMinute,
    });
    unallocated.push(...projection.unallocated);
    resourceBars.push(...projection.resourceBars);
  }

  sortUnallocatedCheckInFlights(unallocated);
  sortCheckInResourceBars(resourceBars);
  assignResourceBarStacks(resourceBars);

  return {
    roster: resolvedRoster,
    resourceRows,
    resourceSections,
    unallocated,
    resourceBars,
  };
}

export function allocateCheckInCounters({
  record,
  records,
  modifications,
  settings,
  roster,
  resources,
  startCounter,
}: {
  record: FlightRecord;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  roster: CheckInCounter[];
  resources?: CheckInCounterResourceRow[];
  startCounter: CheckInCounter;
}): FlightModification {
  const startIndex = findCounterIndex(roster, startCounter);
  if (startIndex < 0) throw new Error(`Counter ${displayCheckInCounter(startCounter)} is not in the counter roster.`);
  const demand = getRequiredCheckInCounters(record, settings).requiredCounters;
  const counters = roster.slice(startIndex, startIndex + demand);
  if (counters.length !== demand) throw new Error('Not enough contiguous counters are available for check-in allocation.');
  const window = buildCheckInWindow(record);
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: roster });
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,

    proposedCounters: counters,
    proposedWindow: window,
  });
  validateResourceLocks({ counters, window, resources: resourceContext.resources });
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: 'grouped',
    checkInCounterWindows: null,
    ...buildDerivedBhsPatch(resourceContext.resources, counters),
  });
}

export function breakCheckInAllocation({
  record,
  currentCounter,
}: {
  record: FlightRecord;
  currentCounter?: FlightCounter | CheckInCounter[] | null;
}): FlightModification {
  const counters = normalizeCheckInCounterList(currentCounter ?? record.counter);
  if (counters.length === 0) throw new Error('Cannot break an unallocated check-in record.');
  const window = buildCheckInWindow(record);
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: 'broken',
    checkInCounterWindows: buildCounterWindowMap(counters, window),
  });
}

export function reshapeCheckInAllocation({
  record,
  roster,
  resources,
  settings,
  records,
  modifications,
}: {
  record: FlightRecord;
  roster: CheckInCounter[];
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const currentCounters = normalizeCheckInCounterList(record.counter);
  const counters = buildContiguousCountersFromLowest(currentCounters, roster);
  const window = buildCheckInWindow(record);
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,
    proposedCounters: counters,
    proposedWindow: window,
  });
  validateResourceLocks({ counters, window, resources: resourceContext.resources });
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: 'grouped',
    checkInCounterWindows: null,
    ...buildDerivedBhsPatch(resourceContext.resources, counters),
  });
}

export function moveCheckInAllocation({
  record,
  roster,
  resources,
  settings,
  counter,
  rowDelta,
  minuteDelta,
  records,
  modifications,
}: {
  record: FlightRecord;
  roster: CheckInCounter[];
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
  counter?: CheckInCounter;
  rowDelta: number;
  minuteDelta: number;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const currentCounters = normalizeCheckInCounterList(record.counter);
  const currentMode = record.checkInAllocationMode ?? (areCountersContiguous(currentCounters, roster) ? 'grouped' : 'broken');
  const counters = currentMode === 'broken' && counter != null
    ? buildMovedSingleCounter(currentCounters, roster, counter, rowDelta)
    : buildMovedCounters(currentCounters, roster, rowDelta);
  const currentWindow = buildCheckInWindow(record);
  const snappedDelta = snapMinutes(minuteDelta);
  const window: CheckInWindow = {
    start: addMinutes(currentWindow.start, snappedDelta),
    end: addMinutes(currentWindow.end, snappedDelta),
  };
  let proposedWindow = window;
  let proposedCounters = counters;
  let counterWindowPatch: Pick<FlightModification, 'checkInCounterWindows'> = { checkInCounterWindows: null };
  if (currentMode === 'broken') {
    const counterWindows = ensureCounterWindowMap(record, currentCounters);
    if (counter != null) {
      const currentCounterIndex = currentCounters.findIndex((item) => counterKey(item) === counterKey(counter));
      if (currentCounterIndex < 0) throw new Error('Selected counter is not assigned to this check-in allocation.');
      const nextCounter = counters[currentCounterIndex];
      const previousKey = counterKey(counter);
      const nextKey = counterKey(nextCounter);
      const currentCounterWindow = counterWindows[previousKey] ?? buildCheckInCounterWindow(record, counter);
      const movedCounterWindow = {
        start: addMinutes(currentCounterWindow.start, snappedDelta),
        end: addMinutes(currentCounterWindow.end, snappedDelta),
      };
      if (nextKey !== previousKey) delete counterWindows[previousKey];
      counterWindows[nextKey] = movedCounterWindow;
      proposedWindow = movedCounterWindow;
      proposedCounters = [nextCounter];
    }
    counterWindowPatch = { checkInCounterWindows: compactCounterWindowMap(counterWindows, counters) };
  }
  validateCountersInRoster(counters, roster);
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,

    proposedCounters,
    proposedWindow,
  });
  validateResourceLocks({ counters: proposedCounters, window: proposedWindow, resources: resourceContext.resources });
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: currentMode,
    ...counterWindowPatch,
    ...buildDerivedBhsPatch(resourceContext.resources, counters),
  });
}

export function resizeCheckInAllocation({
  record,
  counter,
  edge,
  minuteDelta,
  records,
  modifications,
  resources,
  settings,
}: {
  record: FlightRecord;
  counter?: CheckInCounter;
  edge: 'start' | 'end';
  minuteDelta: number;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
}): FlightModification {
  const counters = normalizeCheckInCounterList(record.counter);
  const sharedWindow = buildCheckInWindow(record);
  const currentWindow = record.checkInAllocationMode === 'broken' && counter != null
    ? buildCheckInCounterWindow(record, counter)
    : sharedWindow;
  const snappedDelta = snapResizeMinutes(minuteDelta);
  const window: CheckInWindow = edge === 'start'
    ? { start: addMinutes(currentWindow.start, snappedDelta), end: currentWindow.end }
    : { start: currentWindow.start, end: addMinutes(currentWindow.end, snappedDelta) };
  const scopedCounters = record.checkInAllocationMode === 'broken' && counter != null ? [counter] : counters;
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,

    proposedCounters: scopedCounters,
    proposedWindow: window,
  });
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateResourceLocks({ counters: scopedCounters, window, resources: resourceContext.resources });
  if (record.checkInAllocationMode === 'broken' && counter != null) {
    const counterWindows = ensureCounterWindowMap(record, counters);
    counterWindows[counterKey(counter)] = window;
    return buildModification(record, {
      counter: counters,
      checkInStart: sharedWindow.start,
      checkInEnd: sharedWindow.end,
      checkInAllocationMode: 'broken',
      checkInCounterWindows: compactCounterWindowMap(counterWindows, counters),
    });
  }
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: record.checkInAllocationMode ?? null,
    checkInCounterWindows: null,
  });
}

export function overrideCheckInTimes({
  record,
  counter,
  start,
  end,
  records = [],
  modifications = new Map<string, FlightModification>(),
  resources,
  settings,
}: {
  record: FlightRecord;
  counter?: CheckInCounter;
  start: string;
  end: string;
  records?: FlightRecord[];
  modifications?: Map<string, FlightModification>;
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
}): FlightModification {
  const window = { start, end };
  const counters = normalizeCheckInCounterList(record.counter);
  const scopedCounters = record.checkInAllocationMode === 'broken' && counter != null ? [counter] : counters;
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,
    proposedCounters: scopedCounters,
    proposedWindow: window,
  });
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateResourceLocks({ counters: scopedCounters, window, resources: resourceContext.resources });
  if (record.checkInAllocationMode === 'broken' && counter != null) {
    const sharedWindow = buildCheckInWindow(record);
    const counterWindows = ensureCounterWindowMap(record, counters);
    counterWindows[counterKey(counter)] = window;
    return buildModification(record, {
      counter: record.counter,
      checkInStart: sharedWindow.start,
      checkInEnd: sharedWindow.end,
      checkInAllocationMode: 'broken',
      checkInCounterWindows: compactCounterWindowMap(counterWindows, counters),
    });
  }
  return buildModification(record, {
    counter: record.counter,
    checkInStart: start,
    checkInEnd: end,
    checkInAllocationMode: record.checkInAllocationMode ?? null,
    checkInCounterWindows: null,
  });
}

export function addCheckInCounter({
  record,
  roster,
  resources,
  settings,
  records,
  modifications,
}: {
  record: FlightRecord;
  roster: CheckInCounter[];
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}): FlightModification {
  const currentCounters = normalizeCheckInCounterList(record.counter);
  if (currentCounters.length === 0) throw new Error('Cannot add a counter to an unallocated check-in record.');
  const indexes = currentCounters.map((counter) => findCounterIndex(roster, counter)).sort((a, b) => a - b);
  if (indexes.some((index) => index < 0)) throw new Error('Current counter is not in the counter roster.');
  const mode = record.checkInAllocationMode ?? (areCountersContiguous(currentCounters, roster) ? 'grouped' : 'broken');
  const nextIndex = indexes[indexes.length - 1] + 1;
  if (nextIndex >= roster.length) throw new Error('No available counter row to add.');
  const counters = mode === 'grouped'
    ? roster.slice(indexes[0], nextIndex + 1)
    : [...currentCounters, roster[nextIndex]];
  const window = buildCheckInWindow(record);
  let counterWindowPatch: Pick<FlightModification, 'checkInCounterWindows'> = { checkInCounterWindows: null };
  if (mode === 'broken') {
    const counterWindows = ensureCounterWindowMap(record, currentCounters);
    counterWindows[counterKey(roster[nextIndex])] = { ...window };
    counterWindowPatch = { checkInCounterWindows: compactCounterWindowMap(counterWindows, counters) };
  }
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: counters });
  validateNoConflicts({
    records,
    modifications,
    proposedRecordId: record.id,

    proposedCounters: counters,
    proposedWindow: window,
  });
  validateResourceLocks({ counters, window, resources: resourceContext.resources });
  return buildModification(record, {
    counter: counters,
    checkInStart: window.start,
    checkInEnd: window.end,
    checkInAllocationMode: mode,
    ...counterWindowPatch,
    ...buildDerivedBhsPatch(resourceContext.resources, counters),
  });
}

export function removeCheckInCounter({
  record,
  clickedCounter,
  resources,
  settings,
}: {
  record: FlightRecord;
  clickedCounter: CheckInCounter;
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
}): FlightModification {
  const currentCounters = normalizeCheckInCounterList(record.counter);
  if (currentCounters.length <= 1) throw new Error('Use Unallocate to remove the final check-in counter.');
  const mode = record.checkInAllocationMode ?? 'grouped';
  const counters = mode === 'grouped'
    ? currentCounters.slice(0, -1)
    : currentCounters.filter((counter) => counterKey(counter) !== counterKey(clickedCounter));
  if (counters.length === 0) throw new Error('Use Unallocate to remove the final check-in counter.');
  let counterWindowPatch: Pick<FlightModification, 'checkInCounterWindows'> = { checkInCounterWindows: null };
  if (mode === 'broken') {
    const counterWindows = ensureCounterWindowMap(record, currentCounters);
    delete counterWindows[counterKey(clickedCounter)];
    counterWindowPatch = { checkInCounterWindows: compactCounterWindowMap(counterWindows, counters) };
  }
  const resourceContext = buildResourceContext({ settings, resources, assignedCounters: currentCounters });
  return buildModification(record, {
    counter: counters,
    checkInStart: buildCheckInWindow(record).start,
    checkInEnd: buildCheckInWindow(record).end,
    checkInAllocationMode: mode,
    ...counterWindowPatch,
    ...buildDerivedBhsPatch(resourceContext.resources, counters),
  });
}

export function unallocateCheckInRecord(record: FlightRecord): FlightModification {
  return buildModification(record, {
    counter: null,
    checkInStart: null,
    checkInEnd: null,
    checkInAllocationMode: null,
    checkInCounterWindows: null,
    bhs: null,
  });
}

export function buildCheckInPeriodUnallocationModifications({
  records,
  resourceBars,
  resources,
  settings,
}: {
  records: FlightRecord[];
  resourceBars: Array<Pick<CheckInResourceBar, 'recordId' | 'counter' | 'mode'>>;
  resources?: CheckInCounterResourceRow[];
  settings?: OperationalSettings;
}): FlightModification[] {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const barsByRecord = new Map<string, Array<Pick<CheckInResourceBar, 'recordId' | 'counter' | 'mode'>>>();
  for (const bar of resourceBars) {
    barsByRecord.set(bar.recordId, [...(barsByRecord.get(bar.recordId) ?? []), bar]);
  }

  const mods: FlightModification[] = [];
  for (const [recordId, bars] of barsByRecord) {
    let currentRecord = recordsById.get(recordId);
    if (!currentRecord) continue;
    const currentCounters = normalizeCheckInCounterList(currentRecord.counter);
    if (currentCounters.length === 0) continue;

    const visibleKeys = new Set(bars.map((bar) => counterKey(bar.counter)));
    const visibleCounters = currentCounters.filter((counter) => visibleKeys.has(counterKey(counter)));
    if (visibleCounters.length === 0) continue;

    const canRemovePartialBrokenShape =
      bars.some((bar) => bar.mode === 'broken') &&
      visibleCounters.length < currentCounters.length;
    if (!canRemovePartialBrokenShape) {
      mods.push(unallocateCheckInRecord(currentRecord));
      continue;
    }

    let finalMod: FlightModification | null = null;
    for (const counter of visibleCounters) {
      const remainingCounters = normalizeCheckInCounterList(currentRecord.counter);
      if (remainingCounters.length <= 1) {
        finalMod = unallocateCheckInRecord(currentRecord);
      } else {
        finalMod = removeCheckInCounter({
          record: currentRecord,
          clickedCounter: counter,
          resources,
          settings,
        });
      }
      const nextRecord = applyRecordModification(currentRecord, finalMod);
      if (!nextRecord) break;
      currentRecord = nextRecord;
    }
    if (finalMod) mods.push(finalMod);
  }
  return mods;
}
