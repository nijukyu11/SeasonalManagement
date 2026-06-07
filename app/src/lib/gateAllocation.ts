import type { DailyCellField, DailyScheduleRow } from './dailySchedule';
import type { AirlineColorSetting, FlightModification, FlightRecord, OperationalSettings } from './types';

const DEFAULT_GATE_START_OFFSET_MINUTES = -150;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const FULL_LABEL_MIN_WIDTH = 100;
const GATE_COLOR_PALETTE = [
  { backgroundColor: '#dbeafe', borderColor: '#2563eb', textColor: '#172554', focusColor: 'rgba(37, 99, 235, 0.22)' },
  { backgroundColor: '#dcfce7', borderColor: '#16a34a', textColor: '#052e16', focusColor: 'rgba(22, 163, 74, 0.22)' },
  { backgroundColor: '#fef3c7', borderColor: '#d97706', textColor: '#451a03', focusColor: 'rgba(217, 119, 6, 0.22)' },
  { backgroundColor: '#ccfbf1', borderColor: '#0d9488', textColor: '#042f2e', focusColor: 'rgba(13, 148, 136, 0.22)' },
  { backgroundColor: '#ffe4e6', borderColor: '#e11d48', textColor: '#4c0519', focusColor: 'rgba(225, 29, 72, 0.22)' },
] as const;

export interface GateWindow {
  start: string;
  end: string;
}

export interface GateTimelineTick {
  at: string;
  label: string;
  leftPercent: number;
}

export interface GateTimelineTicks {
  macro: GateTimelineTick[];
  major: GateTimelineTick[];
  minor: GateTimelineTick[];
}

export interface GateResourceRow {
  gate: number;
  gateId: string | null;
  label: string;
  enabled: boolean;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSortOrder: number | null;
  clusterId: string;
  clusterName: string;
  isLegacy: boolean;
}

export interface GateResourceSection {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
}

export interface GateFlightItem {
  record: FlightRecord;
  window: GateWindow;
}

export interface GatePackedItem extends GateFlightItem {
  laneIndex: number;
  leftPercent: number;
  widthPercent: number;
}

export interface GatePackedRows {
  laneCount: number;
  items: GatePackedItem[];
}

export type GateLabelMode = 'full' | 'flightOnly';

export interface GateResourceBar {
  id: string;
  recordId: string;
  groupId: string;
  gate: number;
  gateIndex: number;
  flightNumber: string;
  start: string;
  end: string;
  startLabel: string;
  endLabel: string;
  leftPercent: number;
  widthPercent: number;
  labelMode: GateLabelMode;
  stackIndex: number;
  stackLaneCount: number;
}

export interface GateAllocationView {
  roster: number[];
  resourceRows: GateResourceRow[];
  resourceSections: GateResourceSection[];
  unallocated: GateFlightItem[];
  resourceBars: GateResourceBar[];
}

export interface GateRecordProjection {
  recordId: string;
  unallocated: GateFlightItem[];
  resourceBars: GateResourceBar[];
}

export interface GateColorToken {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  focusColor: string;
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

function windowOverlaps(left: GateWindow, right: GateWindow): boolean {
  return parseLocalDateTime(left.start).getTime() < parseLocalDateTime(right.end).getTime() &&
    parseLocalDateTime(right.start).getTime() < parseLocalDateTime(left.end).getTime();
}

function normalizePositiveInteger(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function buildEffectiveRecord(record: FlightRecord, mod: FlightModification | undefined): FlightRecord | null {
  if (!mod) return record;
  if (mod.action === 'deleted') return null;
  if (mod.action === 'added' && mod.addedLeg) return { ...record, ...mod.addedLeg } as FlightRecord;
  return { ...record, ...mod } as FlightRecord;
}

function formatGateDisplayTime(value: string): string {
  const date = parseLocalDateTime(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function gateKey(gate: number): string {
  return `GATE:${gate}`;
}

function collectAssignedGates(records: Array<Pick<FlightRecord, 'gate'>>): number[] {
  const gates: number[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const gate = normalizePositiveInteger(record.gate);
    if (gate == null) continue;
    const key = gateKey(gate);
    if (seen.has(key)) continue;
    seen.add(key);
    gates.push(gate);
  }
  return gates.sort((left, right) => left - right);
}

function compareResourceRows(left: GateResourceRow, right: GateResourceRow): number {
  const leftRank = left.isLegacy ? 2 : left.groupId == null ? 1 : 0;
  const rightRank = right.isLegacy ? 2 : right.groupId == null ? 1 : 0;
  return leftRank - rightRank ||
    (left.groupSortOrder ?? Number.MAX_SAFE_INTEGER) - (right.groupSortOrder ?? Number.MAX_SAFE_INTEGER) ||
    naturalCompare(left.groupName ?? '', right.groupName ?? '') ||
    left.sortOrder - right.sortOrder ||
    left.gate - right.gate;
}

function resourceFromLegacyGate(gate: number, sortOrder: number): GateResourceRow {
  return {
    gate,
    gateId: null,
    label: String(gate),
    enabled: true,
    sortOrder,
    groupId: null,
    groupName: null,
    groupSortOrder: null,
    clusterId: 'legacy',
    clusterName: 'Legacy / Unmapped',
    isLegacy: true,
  };
}

function buildGateResourceRows(settings: OperationalSettings, assignedGates: number[]): GateResourceRow[] {
  const groupsByGateId = new Map<string, { id: string; name: string; sortOrder: number }>();
  for (const group of settings.gateGroups) {
    for (const gateId of group.gateIds) {
      groupsByGateId.set(gateId, { id: group.id, name: group.name, sortOrder: group.sortOrder });
    }
  }

  const rows: GateResourceRow[] = [];
  const seen = new Set<string>();
  for (const gateResource of settings.gateResources) {
    const gate = normalizePositiveInteger(gateResource.label);
    if (gate == null) continue;
    const group = groupsByGateId.get(gateResource.id) ?? null;
    const key = gateKey(gate);
    seen.add(key);
    rows.push({
      gate,
      gateId: gateResource.id,
      label: gateResource.label,
      enabled: gateResource.enabled,
      sortOrder: gateResource.sortOrder,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      groupSortOrder: group?.sortOrder ?? null,
      clusterId: group?.id ?? 'ungrouped',
      clusterName: group?.name ?? 'Ungrouped',
      isLegacy: false,
    });
  }
  assignedGates.forEach((gate, index) => {
    const key = gateKey(gate);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(resourceFromLegacyGate(gate, Number.MAX_SAFE_INTEGER - assignedGates.length + index));
  });
  return rows.sort(compareResourceRows);
}

function buildGateResourceSections(resources: GateResourceRow[]): GateResourceSection[] {
  const sections: GateResourceSection[] = [];
  resources.forEach((resource, index) => {
    const previous = sections[sections.length - 1];
    if (previous && previous.id === resource.clusterId) {
      previous.endIndex = index;
      return;
    }
    sections.push({
      id: resource.clusterId,
      name: resource.clusterName,
      startIndex: index,
      endIndex: index,
    });
  });
  return sections;
}

function assignResourceBarStacks(bars: GateResourceBar[]): void {
  const byGateIndex = new Map<number, GateResourceBar[]>();
  for (const bar of bars) byGateIndex.set(bar.gateIndex, [...(byGateIndex.get(bar.gateIndex) ?? []), bar]);
  for (const rowBars of byGateIndex.values()) {
    const laneEnds: string[] = [];
    rowBars.sort((left, right) => left.start.localeCompare(right.start) || left.flightNumber.localeCompare(right.flightNumber));
    for (const bar of rowBars) {
      const laneIndex = laneEnds.findIndex((end) => parseLocalDateTime(end).getTime() <= parseLocalDateTime(bar.start).getTime());
      const resolvedLane = laneIndex >= 0 ? laneIndex : laneEnds.length;
      laneEnds[resolvedLane] = bar.end;
      bar.stackIndex = resolvedLane;
      bar.stackLaneCount = laneEnds.length;
    }
    for (const bar of rowBars) bar.stackLaneCount = laneEnds.length;
  }
}

function sortBars(bars: GateResourceBar[]): void {
  bars.sort((left, right) => left.gateIndex - right.gateIndex || left.start.localeCompare(right.start) || left.flightNumber.localeCompare(right.flightNumber));
}

function sortUnallocated(items: GateFlightItem[]): void {
  items.sort((left, right) => left.window.start.localeCompare(right.window.start) || formatGateFlightLabel(left.record).localeCompare(formatGateFlightLabel(right.record)));
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

function mergePreviousModification(
  previousModifications: Map<string, FlightModification>,
  mod: FlightModification
): FlightModification {
  const previous = previousModifications.get(mod.legId) ?? null;
  return {
    ...previous,
    ...mod,
    legId: mod.legId,
    action: 'modified',
  };
}

export function formatGateFlightLabel(record: Pick<FlightRecord, 'airline' | 'flightNumber' | 'rawFlightNumber'>): string {
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

export function buildDefaultGateWindow(record: Pick<FlightRecord, 'date' | 'schedule'>): GateWindow {
  const end = recordStdDateTime(record);
  const start = addMinutes(end, DEFAULT_GATE_START_OFFSET_MINUTES);
  return { start, end };
}

export function buildGateTimelineTicks(from: string, to: string): GateTimelineTicks {
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  assertTimelineRange(from, to);
  const totalMinutes = minutesBetween(from, to);
  const minor: GateTimelineTick[] = [];
  const major: GateTimelineTick[] = [];
  const macro: GateTimelineTick[] = [];
  const seenMacroDays = new Set<string>();

  for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor.setMinutes(cursor.getMinutes() + 15)) {
    const at = formatLocalDateTime(cursor);
    const leftPercent = totalMinutes === 0 ? 0 : (minutesBetween(from, at) / totalMinutes) * 100;
    minor.push({ at, label: formatGateDisplayTime(at), leftPercent });
    if (cursor.getMinutes() === 0) major.push({ at, label: formatGateDisplayTime(at), leftPercent });
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

export function chooseGateLabelMode(widthPixels: number): GateLabelMode {
  return widthPixels >= FULL_LABEL_MIN_WIDTH ? 'full' : 'flightOnly';
}

export function getGateColorToken(
  record: Pick<FlightRecord, 'airline' | 'flightNumber' | 'rawFlightNumber'>,
  settings?: Pick<OperationalSettings, 'airlineColors'> | { airlineColors?: AirlineColorSetting[] } | null
): GateColorToken {
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
  return GATE_COLOR_PALETTE[hashText(airline || formatGateFlightLabel(record)) % GATE_COLOR_PALETTE.length];
}

export function buildGatePackedRows(items: GateFlightItem[], from: string, to: string): GatePackedRows {
  assertTimelineRange(from, to);
  const timelineWindow = { start: from, end: to };
  const totalMinutes = minutesBetween(from, to);
  const laneEnds: string[] = [];
  const packed = [...items]
    .filter((item) => windowOverlaps(item.window, timelineWindow))
    .sort((left, right) =>
      left.window.start.localeCompare(right.window.start) ||
      recordStdDateTime(left.record).localeCompare(recordStdDateTime(right.record)) ||
      formatGateFlightLabel(left.record).localeCompare(formatGateFlightLabel(right.record))
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

export function resolveGateForStand(stand: number | string | null | undefined, settings: OperationalSettings): number | null {
  const normalizedStand = normalizePositiveInteger(stand);
  if (normalizedStand == null) return null;
  return settings.standGateMappings
    .filter((mapping) => mapping.enabled)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .find((mapping) => mapping.stand === normalizedStand)?.gate ?? null;
}

export function buildGateRecordProjection({
  recordId,
  record,
  from,
  to,
  roster,
  pixelsPerMinute,
}: {
  recordId: string;
  record: FlightRecord | null;
  from: string;
  to: string;
  roster: number[];
  pixelsPerMinute: number;
}): GateRecordProjection {
  assertTimelineRange(from, to);
  const projection: GateRecordProjection = {
    recordId,
    unallocated: [],
    resourceBars: [],
  };
  if (!record || record.type !== 'D' || record.status === 'deleted') return projection;

  const timelineWindow = { start: from, end: to };
  const window = buildDefaultGateWindow(record);
  if (!windowOverlaps(window, timelineWindow)) return projection;

  const gate = normalizePositiveInteger(record.gate);
  const rosterIndexes = new Map(roster.map((item, index) => [gateKey(item), index]));
  if (gate == null) {
    projection.unallocated.push({ record, window });
    return projection;
  }

  const gateIndex = rosterIndexes.get(gateKey(gate));
  if (gateIndex == null) {
    projection.unallocated.push({ record, window });
    return projection;
  }

  const totalMinutes = minutesBetween(from, to);
  const visibleStart = laterDateTime(window.start, from);
  const visibleEnd = earlierDateTime(window.end, to);
  const widthPixels = minutesBetween(visibleStart, visibleEnd) * pixelsPerMinute;
  projection.resourceBars.push({
    id: `${record.id}:G${gate}`,
    recordId: record.id,
    groupId: record.id,
    gate,
    gateIndex,
    flightNumber: formatGateFlightLabel(record),
    start: window.start,
    end: window.end,
    startLabel: formatGateDisplayTime(window.start),
    endLabel: formatGateDisplayTime(window.end),
    leftPercent: (minutesBetween(from, visibleStart) / totalMinutes) * 100,
    widthPercent: (minutesBetween(visibleStart, visibleEnd) / totalMinutes) * 100,
    labelMode: chooseGateLabelMode(widthPixels),
    stackIndex: 0,
    stackLaneCount: 1,
  });
  return projection;
}

export function mergeGateAllocationViewPatch(
  view: GateAllocationView,
  patch: GateRecordProjection | GateRecordProjection[]
): GateAllocationView {
  const patches = Array.isArray(patch) ? patch : [patch];
  const patchedRecordIds = new Set(patches.map((item) => item.recordId));
  const unallocated = view.unallocated.filter((item) => !patchedRecordIds.has(item.record.id));
  const resourceBars = view.resourceBars.filter((bar) => !patchedRecordIds.has(bar.recordId));
  for (const item of patches) {
    unallocated.push(...item.unallocated);
    resourceBars.push(...item.resourceBars);
  }
  sortUnallocated(unallocated);
  sortBars(resourceBars);
  assignResourceBarStacks(resourceBars);
  return {
    ...view,
    unallocated,
    resourceBars,
  };
}

export function buildGateAllocationView({
  records,
  modifications,
  settings,
  from,
  to,
  groupByGateGroup = true,
  pixelsPerMinute,
}: {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  from: string;
  to: string;
  groupByGateGroup?: boolean;
  pixelsPerMinute: number;
}): GateAllocationView {
  assertTimelineRange(from, to);
  const effectiveRecords = records
    .filter((record) => record.type === 'D' && record.status !== 'deleted')
    .map((record) => buildEffectiveRecord(record, modifications.get(record.id)))
    .filter((record): record is FlightRecord => record != null);
  const resourceRows = buildGateResourceRows(settings, collectAssignedGates(effectiveRecords));
  const groupedRows = groupByGateGroup ? resourceRows : [...resourceRows].sort((left, right) => left.gate - right.gate);
  const resourceSections = groupByGateGroup
    ? buildGateResourceSections(groupedRows)
    : [{ id: 'all-gates', name: 'All Gates', startIndex: 0, endIndex: Math.max(0, groupedRows.length - 1) }];
  const roster = groupedRows.map((row) => row.gate);
  const unallocated: GateFlightItem[] = [];
  const resourceBars: GateResourceBar[] = [];

  for (const record of effectiveRecords) {
    const projection = buildGateRecordProjection({
      recordId: record.id,
      record,
      from,
      to,
      roster,
      pixelsPerMinute,
    });
    unallocated.push(...projection.unallocated);
    resourceBars.push(...projection.resourceBars);
  }

  sortUnallocated(unallocated);
  sortBars(resourceBars);
  assignResourceBarStacks(resourceBars);
  return {
    roster,
    resourceRows: groupedRows,
    resourceSections,
    unallocated,
    resourceBars,
  };
}

export function allocateGate(record: FlightRecord, gate: number): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    gate,
  };
}

export function unallocateGate(record: FlightRecord): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    gate: null,
  };
}

export function buildDailyStandGateModifications({
  row,
  record,
  field,
  value,
  settings,
  previousModifications,
}: {
  row: Pick<DailyScheduleRow, 'arr' | 'dep'>;
  record: FlightRecord;
  field: DailyCellField;
  value: string;
  settings: OperationalSettings;
  previousModifications: Map<string, FlightModification>;
}): FlightModification[] {
  if (field !== 'stand' && field !== 'arrStand') return [];
  const stand = normalizePositiveInteger(value);
  const gate = stand == null ? null : resolveGateForStand(stand, settings);
  const mods = new Map<string, FlightModification>();
  const standMod = mergePreviousModification(previousModifications, {
    legId: record.id,
    action: 'modified',
    stand,
  });
  mods.set(standMod.legId, standMod);
  if (gate != null || stand == null) {
    const gateRecord = row.dep ?? (record.type === 'D' ? record : null);
    if (gateRecord) {
      const existing = mods.get(gateRecord.id) ?? previousModifications.get(gateRecord.id) ?? {
        legId: gateRecord.id,
        action: 'modified' as const,
      };
      mods.set(gateRecord.id, {
        ...existing,
        legId: gateRecord.id,
        action: 'modified',
        gate,
      });
    }
  }
  return Array.from(mods.values());
}
