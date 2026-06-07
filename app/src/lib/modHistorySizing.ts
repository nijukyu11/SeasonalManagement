import type { ModHistoryEntry } from './types';

export const FIRESTORE_DOCUMENT_MAX_BYTES = 1_048_576;
export const FIRESTORE_MOD_HISTORY_SAFE_BYTES = 850_000;

type HistoryBucket = Pick<ModHistoryEntry, 'changes' | 'recordChanges'>;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function cloneEntryBase(entry: ModHistoryEntry, id: string, description: string): ModHistoryEntry {
  return {
    ...entry,
    id,
    description,
    changes: [],
    recordChanges: [],
  };
}

function entryWithBucket(entry: ModHistoryEntry, bucket: HistoryBucket, id: string, part: number, total: number): ModHistoryEntry {
  const suffix = total > 1 ? ` (${part}/${total})` : '';
  const next = cloneEntryBase(entry, id, `${entry.description}${suffix}`);
  next.changes = bucket.changes;
  next.recordChanges = bucket.recordChanges && bucket.recordChanges.length > 0 ? bucket.recordChanges : undefined;
  return next;
}

function bucketBytes(entry: ModHistoryEntry, bucket: HistoryBucket): number {
  return estimateModHistoryEntryBytes(entryWithBucket(entry, bucket, entry.id, 1, 1));
}

function pushBucket(buckets: HistoryBucket[], bucket: HistoryBucket): void {
  if (bucket.changes.length > 0 || (bucket.recordChanges?.length ?? 0) > 0) {
    buckets.push({
      changes: [...bucket.changes],
      recordChanges: bucket.recordChanges ? [...bucket.recordChanges] : [],
    });
  }
}

function splitHistoryBuckets(entry: ModHistoryEntry, maxBytes: number): HistoryBucket[] {
  const buckets: HistoryBucket[] = [];
  let current: HistoryBucket = { changes: [], recordChanges: [] };
  const items: Array<
    | { kind: 'change'; value: ModHistoryEntry['changes'][number] }
    | { kind: 'recordChange'; value: NonNullable<ModHistoryEntry['recordChanges']>[number] }
  > = [
    ...entry.changes.map((value) => ({ kind: 'change' as const, value })),
    ...(entry.recordChanges ?? []).map((value) => ({ kind: 'recordChange' as const, value })),
  ];

  for (const item of items) {
    const candidate: HistoryBucket = {
      changes: item.kind === 'change' ? [...current.changes, item.value] : current.changes,
      recordChanges: item.kind === 'recordChange' ? [...(current.recordChanges ?? []), item.value] : current.recordChanges,
    };

    if (bucketBytes(entry, candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    pushBucket(buckets, current);
    current = {
      changes: item.kind === 'change' ? [item.value] : [],
      recordChanges: item.kind === 'recordChange' ? [item.value] : [],
    };

    if (bucketBytes(entry, current) > maxBytes) {
      throw new Error(`A single modHistory change in ${entry.id} exceeds the safe Firestore document size.`);
    }
  }

  pushBucket(buckets, current);
  return buckets;
}

export function estimateModHistoryEntryBytes(entry: ModHistoryEntry): number {
  return byteLength(entry);
}

export function splitModHistoryEntryForFirestore(
  entry: ModHistoryEntry,
  maxBytes = FIRESTORE_MOD_HISTORY_SAFE_BYTES
): ModHistoryEntry[] {
  if (estimateModHistoryEntryBytes(entry) <= maxBytes) return [entry];

  const buckets = splitHistoryBuckets(entry, maxBytes);
  if (buckets.length <= 1) return [entryWithBucket(entry, buckets[0], entry.id, 1, 1)];

  const total = buckets.length;
  return buckets.map((bucket, index) => {
    const part = index + 1;
    const id = `${entry.id}_PART_${String(part).padStart(3, '0')}`;
    return entryWithBucket(entry, bucket, id, part, total);
  });
}

export function splitModHistoryEntriesForFirestore(entries: ModHistoryEntry[]): ModHistoryEntry[] {
  return entries.flatMap((entry) => splitModHistoryEntryForFirestore(entry));
}
