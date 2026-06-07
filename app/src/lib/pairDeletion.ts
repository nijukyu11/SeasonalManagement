import type { FlightLeg, FlightRecord } from './types';

export type PairDeletionScope = 'pair' | 'selected' | 'cancel';

type PairDeletionItem = Pick<FlightLeg, 'id' | 'action' | 'type' | 'linkedRecordId' | 'linkId' | 'pairAnchorDate'> &
  Partial<Pick<FlightRecord, 'status' | 'turnaroundId'>>;

export interface LinkedDeletionTargets {
  selectedIds: string[];
  counterpartIds: string[];
  pairIds: string[];
  hasActiveCounterpart: boolean;
}

function uniqueIds(ids: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(ids).filter((id) => id.trim().length > 0)));
}

function isActive(item: PairDeletionItem | undefined): item is PairDeletionItem {
  return item != null && item.status !== 'deleted' && item.action !== 'deleted';
}

function pairIdentity(item: PairDeletionItem): string | null {
  if (item.turnaroundId) return `turnaround:${item.turnaroundId}`;
  if (item.linkId && item.pairAnchorDate) return `link:${item.linkId}:${item.pairAnchorDate}`;
  return null;
}

export function resolveLinkedDeletionTargets(
  items: PairDeletionItem[],
  selectedIdsInput: Iterable<string>
): LinkedDeletionTargets {
  const selectedIds = uniqueIds(selectedIdsInput);
  const selected = new Set(selectedIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  const counterpartIds: string[] = [];
  const addCounterpart = (candidate: PairDeletionItem | undefined) => {
    if (!isActive(candidate) || selected.has(candidate.id) || counterpartIds.includes(candidate.id)) return;
    counterpartIds.push(candidate.id);
  };

  for (const selectedId of selectedIds) {
    const item = byId.get(selectedId);
    if (!isActive(item)) continue;

    if (item.linkedRecordId) {
      addCounterpart(byId.get(item.linkedRecordId));
      continue;
    }

    const identity = pairIdentity(item);
    if (!identity) continue;
    for (const candidate of items) {
      if (candidate.id === item.id) continue;
      if (pairIdentity(candidate) !== identity) continue;
      if (candidate.type === item.type) continue;
      addCounterpart(candidate);
    }
  }

  return {
    selectedIds,
    counterpartIds,
    pairIds: uniqueIds([...selectedIds, ...counterpartIds]),
    hasActiveCounterpart: counterpartIds.length > 0,
  };
}
