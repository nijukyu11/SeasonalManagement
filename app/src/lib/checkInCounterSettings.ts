import type { CheckInCounter, CheckInWindow } from './checkinAllocation';
import type { CheckInCounterLock, CheckInCounterResource, OperationalSettings } from './types';

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

export interface BuildCheckInCounterResourcesInput {
  settings: OperationalSettings;
  assignedCounters: CheckInCounter[];
  groupByCounterGroup: boolean;
  visibleWindow?: CheckInWindow | null;
}

export interface CheckInLockConflict {
  counter: CheckInCounter;
  resource: CheckInCounterResourceRow;
  lock: CheckInCounterLock;
}

const LEGACY_CLUSTER_ID = 'legacy';
const LEGACY_CLUSTER_NAME = 'Legacy / Unmapped';
const UNGROUPED_CLUSTER_ID = 'ungrouped';
const UNGROUPED_CLUSTER_NAME = 'Ungrouped';
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const conflictLocksByResource = new WeakMap<CheckInCounterResourceRow, ActiveCheckInCounterLock[]>();
const bhsValuesByResource = new WeakMap<CheckInCounterResourceRow, string[]>();

function parseLocalDateTime(value: string): number {
  const match = LOCAL_DATETIME_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid local datetime ${value}`);
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
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
  return date.getTime();
}

function windowsOverlap(left: CheckInWindow, right: CheckInWindow): boolean {
  return parseLocalDateTime(left.start) < parseLocalDateTime(right.end) &&
    parseLocalDateTime(right.start) < parseLocalDateTime(left.end);
}

function normalizeLabel(value: unknown): string {
  return String(value ?? '').trim();
}

function counterFromLabel(label: string): CheckInCounter {
  const normalized = normalizeLabel(label);
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized.toUpperCase();
}

function normalizeAssignedCounter(counter: CheckInCounter): CheckInCounter {
  return typeof counter === 'number' ? counter : counterFromLabel(counter);
}

function counterKey(counter: CheckInCounter): string {
  return typeof counter === 'number' ? `N:${counter}` : `S:${counter.toUpperCase()}`;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareResourcesByCounter(left: CheckInCounterResourceRow, right: CheckInCounterResourceRow): number {
  return left.sortOrder - right.sortOrder || naturalCompare(left.label, right.label);
}

function compareResourcesByGroup(left: CheckInCounterResourceRow, right: CheckInCounterResourceRow): number {
  const leftRank = left.isLegacy ? 2 : left.groupId == null ? 1 : 0;
  const rightRank = right.isLegacy ? 2 : right.groupId == null ? 1 : 0;
  return leftRank - rightRank ||
    (left.groupSortOrder ?? Number.MAX_SAFE_INTEGER) - (right.groupSortOrder ?? Number.MAX_SAFE_INTEGER) ||
    naturalCompare(left.groupName ?? '', right.groupName ?? '') ||
    compareResourcesByCounter(left, right);
}

function addParsedLabel(labels: ParsedCheckInCounterInput[], seen: Set<string>, label: string): void {
  const normalized = normalizeLabel(label);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  labels.push({ label: normalized });
}

function expandToken(token: string): string[] {
  const numericRange = /^(\d+)-(\d+)$/.exec(token);
  if (numericRange) {
    const start = Number(numericRange[1]);
    const end = Number(numericRange[2]);
    const step = start <= end ? 1 : -1;
    const labels: string[] = [];
    for (let current = start; current !== end + step; current += step) {
      labels.push(String(current));
    }
    return labels;
  }

  const prefixedRange = /^([A-Za-z]+)(\d+)-(?:(\1)?)(\d+)$/i.exec(token);
  if (prefixedRange) {
    const prefix = prefixedRange[1].toUpperCase();
    const start = Number(prefixedRange[2]);
    const end = Number(prefixedRange[4]);
    const width = Math.max(prefixedRange[2].length, prefixedRange[4].length);
    const step = start <= end ? 1 : -1;
    const labels: string[] = [];
    for (let current = start; current !== end + step; current += step) {
      labels.push(`${prefix}${String(current).padStart(width, '0')}`);
    }
    return labels;
  }

  return [token];
}

function buildGroupLookup(settings: OperationalSettings): Map<string, {
  id: string;
  name: string;
  bhs: string | null;
  sortOrder: number;
}> {
  const groupsByCounterId = new Map<string, {
    id: string;
    name: string;
    bhs: string | null;
    sortOrder: number;
  }>();
  for (const group of settings.checkInCounterGroups) {
    for (const counterId of group.counterIds) {
      groupsByCounterId.set(counterId, {
        id: group.id,
        name: group.name,
        bhs: group.bhs || null,
        sortOrder: group.sortOrder,
      });
    }
  }
  return groupsByCounterId;
}

function activeLocksForCounter(
  counterId: string,
  settings: OperationalSettings,
  visibleWindow: CheckInWindow | null | undefined
): ActiveCheckInCounterLock[] {
  return settings.checkInCounterLocks
    .filter((lock) => lock.enabled && lock.counterIds.includes(counterId))
    .filter((lock) => visibleWindow == null || windowsOverlap({ start: lock.start, end: lock.end }, visibleWindow))
    .map((lock) => ({ lock }));
}

function conflictLocksForCounter(counterId: string, settings: OperationalSettings): ActiveCheckInCounterLock[] {
  return settings.checkInCounterLocks
    .filter((lock) => lock.enabled && lock.counterIds.includes(counterId))
    .map((lock) => ({ lock }));
}

function mergeLocks(
  targetLocks: ActiveCheckInCounterLock[],
  sourceLocks: ActiveCheckInCounterLock[]
): ActiveCheckInCounterLock[] {
  const seenLockIds = new Set(targetLocks.map((entry) => entry.lock.id));
  const merged = [...targetLocks];
  for (const sourceLock of sourceLocks) {
    if (seenLockIds.has(sourceLock.lock.id)) continue;
    seenLockIds.add(sourceLock.lock.id);
    merged.push(sourceLock);
  }
  return merged;
}

function mergeBhsValues(targetValues: string[], sourceValues: string[]): string[] {
  const seenBhs = new Set(targetValues);
  const merged = [...targetValues];
  for (const sourceValue of sourceValues) {
    if (seenBhs.has(sourceValue)) continue;
    seenBhs.add(sourceValue);
    merged.push(sourceValue);
  }
  return merged;
}

function mergeCanonicalResourceMetadata(
  target: CheckInCounterResourceRow,
  duplicate: CheckInCounterResourceRow
): void {
  target.activeLocks = mergeLocks(target.activeLocks, duplicate.activeLocks);
  conflictLocksByResource.set(
    target,
    mergeLocks(conflictLocksByResource.get(target) ?? target.activeLocks, conflictLocksByResource.get(duplicate) ?? duplicate.activeLocks)
  );
  bhsValuesByResource.set(
    target,
    mergeBhsValues(
      bhsValuesByResource.get(target) ?? (target.bhs ? [target.bhs] : []),
      bhsValuesByResource.get(duplicate) ?? (duplicate.bhs ? [duplicate.bhs] : [])
    )
  );
}

function resourceFromConfiguredCounter(
  counter: CheckInCounterResource,
  settings: OperationalSettings,
  groupsByCounterId: Map<string, { id: string; name: string; bhs: string | null; sortOrder: number }>,
  visibleWindow: CheckInWindow | null | undefined
): CheckInCounterResourceRow {
  const group = groupsByCounterId.get(counter.id) ?? null;
  const clusterId = group?.id ?? UNGROUPED_CLUSTER_ID;
  const clusterName = group?.name ?? UNGROUPED_CLUSTER_NAME;
  const clusterBhs = group?.bhs ?? null;
  const resource = {
    counter: counterFromLabel(counter.label),
    counterId: counter.id,
    label: normalizeLabel(counter.label),
    enabled: counter.enabled,
    sortOrder: counter.sortOrder,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    groupSortOrder: group?.sortOrder ?? null,
    bhs: group?.bhs ?? null,
    clusterId,
    clusterName,
    clusterBhs,
    isLegacy: false,
    activeLocks: activeLocksForCounter(counter.id, settings, visibleWindow),
  };
  conflictLocksByResource.set(resource, conflictLocksForCounter(counter.id, settings));
  bhsValuesByResource.set(resource, group?.bhs ? [group.bhs] : []);
  return resource;
}

function resourceFromLegacyCounter(counter: CheckInCounter, sortOrder: number): CheckInCounterResourceRow {
  const normalizedCounter = typeof counter === 'number' ? counter : counter.toUpperCase();
  return {
    counter: normalizedCounter,
    counterId: null,
    label: String(normalizedCounter),
    enabled: true,
    sortOrder,
    groupId: null,
    groupName: null,
    groupSortOrder: null,
    bhs: null,
    clusterId: LEGACY_CLUSTER_ID,
    clusterName: LEGACY_CLUSTER_NAME,
    clusterBhs: null,
    isLegacy: true,
    activeLocks: [],
  };
}

export function parseCheckInCounterInventoryInput(input: string): ParsedCheckInCounterInput[] {
  const labels: ParsedCheckInCounterInput[] = [];
  const seen = new Set<string>();
  for (const token of input.split(/[,\s;]+/)) {
    for (const label of expandToken(token.trim())) {
      addParsedLabel(labels, seen, label);
    }
  }
  return labels;
}

export function buildCheckInCounterResources({
  settings,
  assignedCounters,
  groupByCounterGroup,
  visibleWindow = null,
}: BuildCheckInCounterResourcesInput): CheckInCounterResourceRow[] {
  const groupsByCounterId = buildGroupLookup(settings);
  const resources: CheckInCounterResourceRow[] = [];
  const seenKeys = new Set<string>();
  const resourcesByKey = new Map<string, CheckInCounterResourceRow>();
  for (const counter of settings.checkInCounters) {
    const resource = resourceFromConfiguredCounter(counter, settings, groupsByCounterId, visibleWindow);
    const key = counterKey(resource.counter);
    const existingResource = resourcesByKey.get(key);
    if (existingResource) {
      mergeCanonicalResourceMetadata(existingResource, resource);
      continue;
    }
    seenKeys.add(key);
    resourcesByKey.set(key, resource);
    resources.push(resource);
  }
  assignedCounters.forEach((assignedCounter, index) => {
    const normalizedCounter = normalizeAssignedCounter(assignedCounter);
    const key = counterKey(normalizedCounter);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    resources.push(resourceFromLegacyCounter(normalizedCounter, Number.MAX_SAFE_INTEGER - assignedCounters.length + index));
  });

  return resources.sort(groupByCounterGroup ? compareResourcesByGroup : compareResourcesByCounter);
}

export function buildCheckInCounterSections(resources: CheckInCounterResourceRow[]): CheckInCounterResourceSection[] {
  const sections: CheckInCounterResourceSection[] = [];
  resources.forEach((resource, index) => {
    const previous = sections[sections.length - 1];
    if (previous && previous.id === resource.clusterId) {
      previous.endIndex = index;
      return;
    }
    sections.push({
      id: resource.clusterId,
      name: resource.clusterName,
      bhs: resource.clusterBhs,
      startIndex: index,
      endIndex: index,
    });
  });
  return sections;
}

export function buildCheckInBhsValue(counters: CheckInCounter[], resources: CheckInCounterResourceRow[]): string | null {
  const requestedKeys = new Set(counters.map((counter) => counterKey(normalizeAssignedCounter(counter))));
  const bhsValues: string[] = [];
  const seenBhs = new Set<string>();
  for (const resource of resources) {
    if (!requestedKeys.has(counterKey(resource.counter))) continue;
    for (const bhs of bhsValuesByResource.get(resource) ?? (resource.bhs ? [resource.bhs] : [])) {
      if (seenBhs.has(bhs)) continue;
      seenBhs.add(bhs);
      bhsValues.push(bhs);
    }
  }
  return bhsValues.length === 0 ? null : bhsValues.join(',');
}

export function findCheckInLockConflict(
  counters: CheckInCounter[],
  window: CheckInWindow,
  resources: CheckInCounterResourceRow[]
): CheckInLockConflict | null {
  const requestedKeys = new Set(counters.map((counter) => counterKey(normalizeAssignedCounter(counter))));
  for (const resource of resources) {
    if (!requestedKeys.has(counterKey(resource.counter))) continue;
    for (const activeLock of conflictLocksByResource.get(resource) ?? resource.activeLocks) {
      if (windowsOverlap(window, { start: activeLock.lock.start, end: activeLock.lock.end })) {
        return {
          counter: resource.counter,
          resource,
          lock: activeLock.lock,
        };
      }
    }
  }
  return null;
}
