import type { SeasonChangeEvent } from './seasonChangeEvents.ts';
import type { FlightModification } from './types.ts';

export type SeasonRealtimeRevalidationReason =
  | 'gap'
  | 'missing-sequence'
  | 'incomplete-payload'
  | 'membership-change'
  | 'unknown-target';

export type SeasonRealtimeDecision =
  | { kind: 'ignore-duplicate-or-stale'; serverSeq: number }
  | { kind: 'direct-modification'; serverSeq: number; legId: string; modification: FlightModification }
  | { kind: 'revalidate-window'; reason: SeasonRealtimeRevalidationReason; serverSeq: number | null };

export interface SeasonRealtimeCursor {
  seasonId: string;
  lastServerSeq: number | null;
  appliedEventIds: Set<string>;
  appliedOpIds: Set<string>;
}

interface SeasonRealtimeCursorOptions {
  appliedEventIds?: Iterable<string>;
  appliedOpIds?: Iterable<string>;
}

const DEFAULT_DEDUPE_LIMIT = 512;

export function createSeasonRealtimeCursor(
  seasonId: string,
  lastServerSeq: number | null,
  options: SeasonRealtimeCursorOptions = {},
): SeasonRealtimeCursor {
  return {
    seasonId,
    lastServerSeq: Number.isFinite(lastServerSeq) ? lastServerSeq : null,
    appliedEventIds: new Set(options.appliedEventIds ?? []),
    appliedOpIds: new Set(options.appliedOpIds ?? []),
  };
}

function trimSet(values: Set<string>, limit: number): void {
  while (values.size > limit) {
    const oldest = values.values().next().value;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}

export function rememberSeasonRealtimeEvent(
  cursor: SeasonRealtimeCursor,
  event: SeasonChangeEvent,
  dedupeLimit = DEFAULT_DEDUPE_LIMIT,
): void {
  if (event.seasonId !== cursor.seasonId) return;
  if (Number.isFinite(event.serverSeq)) {
    cursor.lastServerSeq = Math.max(cursor.lastServerSeq ?? -1, event.serverSeq as number);
  }
  if (event.eventId) cursor.appliedEventIds.add(event.eventId);
  if (event.opId) cursor.appliedOpIds.add(event.opId);
  trimSet(cursor.appliedEventIds, dedupeLimit);
  trimSet(cursor.appliedOpIds, dedupeLimit);
}

export function classifySeasonRealtimeEvent(
  event: SeasonChangeEvent,
  cursor: SeasonRealtimeCursor,
): SeasonRealtimeDecision {
  const serverSeq = event.serverSeq;
  if (!Number.isFinite(serverSeq)) {
    return { kind: 'revalidate-window', reason: 'missing-sequence', serverSeq: null };
  }
  const sequence = serverSeq as number;
  if (
    cursor.appliedEventIds.has(event.eventId)
    || cursor.appliedOpIds.has(event.opId)
    || (cursor.lastServerSeq != null && sequence <= cursor.lastServerSeq)
  ) {
    return { kind: 'ignore-duplicate-or-stale', serverSeq: sequence };
  }
  if (event.seasonId !== cursor.seasonId) {
    return { kind: 'revalidate-window', reason: 'unknown-target', serverSeq: sequence };
  }
  if (cursor.lastServerSeq == null || sequence > cursor.lastServerSeq + 1) {
    return { kind: 'revalidate-window', reason: 'gap', serverSeq: sequence };
  }
  if (event.targetType !== 'modification') {
    return { kind: 'revalidate-window', reason: 'unknown-target', serverSeq: sequence };
  }
  if (event.opPayload.type === 'modificationDelete') {
    return { kind: 'revalidate-window', reason: 'membership-change', serverSeq: sequence };
  }
  if (event.opPayload.type !== 'modification' || !event.opPayload.mod) {
    return { kind: 'revalidate-window', reason: 'incomplete-payload', serverSeq: sequence };
  }
  const modification = event.opPayload.mod;
  if (modification.legId !== event.targetId) {
    return { kind: 'revalidate-window', reason: 'incomplete-payload', serverSeq: sequence };
  }
  if (modification.action === 'added' || modification.action === 'deleted') {
    return { kind: 'revalidate-window', reason: 'membership-change', serverSeq: sequence };
  }
  return {
    kind: 'direct-modification',
    serverSeq: sequence,
    legId: modification.legId,
    modification,
  };
}
