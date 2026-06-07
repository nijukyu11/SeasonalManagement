import type { OperationalSettings } from './types';

function toggleId(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

export function resolveSettingsAfterSave(
  current: OperationalSettings,
  savingSnapshotString: string,
  normalized: OperationalSettings
): OperationalSettings {
  return JSON.stringify(current) === savingSnapshotString ? normalized : current;
}

export function deleteCheckInCounterFromSettings(
  current: OperationalSettings,
  counterId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    checkInCounters: current.checkInCounters.filter((item) => item.id !== counterId),
    checkInCounterGroups: current.checkInCounterGroups.map((group) => ({
      ...group,
      counterIds: group.counterIds.filter((id) => id !== counterId),
      updatedAt: now,
    })),
    checkInCounterLocks: current.checkInCounterLocks.map((lock) => ({
      ...lock,
      counterIds: lock.counterIds.filter((id) => id !== counterId),
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

export function toggleCheckInCounterGroupMembership(
  current: OperationalSettings,
  groupId: string,
  counterId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    checkInCounterGroups: current.checkInCounterGroups.map((group) => {
      if (group.id === groupId) {
        return { ...group, counterIds: toggleId(group.counterIds, counterId), updatedAt: now };
      }
      if (group.counterIds.includes(counterId)) {
        return { ...group, counterIds: group.counterIds.filter((id) => id !== counterId), updatedAt: now };
      }
      return group;
    }),
    updatedAt: now,
  };
}

export function toggleCheckInCounterLockMembership(
  current: OperationalSettings,
  lockId: string,
  counterId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    checkInCounterLocks: current.checkInCounterLocks.map((lock) => (
      lock.id === lockId
        ? { ...lock, counterIds: toggleId(lock.counterIds, counterId), updatedAt: now }
        : lock
    )),
    updatedAt: now,
  };
}

export function deleteGateFromSettings(
  current: OperationalSettings,
  gateId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    gateResources: current.gateResources.filter((item) => item.id !== gateId),
    gateGroups: current.gateGroups.map((group) => ({
      ...group,
      gateIds: group.gateIds.filter((id) => id !== gateId),
      updatedAt: now,
    })),
    gateLocks: current.gateLocks.map((lock) => ({
      ...lock,
      gateIds: lock.gateIds.filter((id) => id !== gateId),
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

export function toggleGateGroupMembership(
  current: OperationalSettings,
  groupId: string,
  gateId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    gateGroups: current.gateGroups.map((group) => {
      if (group.id === groupId) {
        return { ...group, gateIds: toggleId(group.gateIds, gateId), updatedAt: now };
      }
      if (group.gateIds.includes(gateId)) {
        return { ...group, gateIds: group.gateIds.filter((id) => id !== gateId), updatedAt: now };
      }
      return group;
    }),
    updatedAt: now,
  };
}

export function toggleGateLockMembership(
  current: OperationalSettings,
  lockId: string,
  gateId: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    gateLocks: current.gateLocks.map((lock) => (
      lock.id === lockId
        ? { ...lock, gateIds: toggleId(lock.gateIds, gateId), updatedAt: now }
        : lock
    )),
    updatedAt: now,
  };
}

export function renameCheckInCounterLabelInSettings(
  current: OperationalSettings,
  counterId: string,
  nextLabel: string,
  now: number
): OperationalSettings {
  return {
    ...current,
    checkInCounters: current.checkInCounters.map((counter) => (
      counter.id === counterId
        ? { ...counter, label: nextLabel.trim(), updatedAt: now }
        : counter
    )),
    updatedAt: now,
  };
}
