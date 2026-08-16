import type { FlightModification } from './types.ts';

export interface GanttTargetKey {
  seasonId: string;
  targetType: 'modification';
  targetId: string;
}

export interface SequencedModificationPatch {
  serverSeq: number;
  modification: FlightModification;
  source: 'remote' | 'local-ack';
}

export type GanttEnqueueResult =
  | { kind: 'queued' }
  | { kind: 'apply'; candidate: SequencedModificationPatch };

function serializeTargetKey(key: GanttTargetKey): string {
  return `${key.seasonId}\u0000${key.targetType}\u0000${key.targetId}`;
}

function latestPatch(
  left: SequencedModificationPatch | null | undefined,
  right: SequencedModificationPatch | null | undefined,
): SequencedModificationPatch | null {
  if (!left) return right ?? null;
  if (!right) return left;
  if (right.serverSeq > left.serverSeq) return right;
  return left;
}

export function createGanttInteractionArbiter() {
  const activeTargets = new Set<string>();
  const queuedByTarget = new Map<string, SequencedModificationPatch>();

  const begin = (key: GanttTargetKey): void => {
    activeTargets.add(serializeTargetKey(key));
  };

  const isActive = (key: GanttTargetKey): boolean => activeTargets.has(serializeTargetKey(key));

  const enqueueOrApply = (
    key: GanttTargetKey,
    candidate: SequencedModificationPatch,
  ): GanttEnqueueResult => {
    const serialized = serializeTargetKey(key);
    if (!activeTargets.has(serialized)) return { kind: 'apply', candidate };
    const queued = latestPatch(queuedByTarget.get(serialized), candidate);
    if (queued) queuedByTarget.set(serialized, queued);
    return { kind: 'queued' };
  };

  const settle = (
    key: GanttTargetKey,
    localAck?: SequencedModificationPatch | null,
  ): SequencedModificationPatch | null => {
    const serialized = serializeTargetKey(key);
    const winner = latestPatch(queuedByTarget.get(serialized), localAck);
    queuedByTarget.delete(serialized);
    activeTargets.delete(serialized);
    return winner;
  };

  const cancel = (key: GanttTargetKey): SequencedModificationPatch | null => settle(key);

  const disposeSeason = (seasonId: string): void => {
    const prefix = `${seasonId}\u0000`;
    for (const key of activeTargets) {
      if (key.startsWith(prefix)) activeTargets.delete(key);
    }
    for (const key of queuedByTarget.keys()) {
      if (key.startsWith(prefix)) queuedByTarget.delete(key);
    }
  };

  const clear = (): void => {
    activeTargets.clear();
    queuedByTarget.clear();
  };

  return { begin, isActive, enqueueOrApply, settle, cancel, disposeSeason, clear };
}

export const ganttInteractionArbiter = createGanttInteractionArbiter();
