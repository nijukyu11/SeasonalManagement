import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySeasonRealtimeEvent,
  createSeasonRealtimeCursor,
} from './seasonRealtimePatch.ts';
import type { SeasonChangeEvent } from './seasonChangeEvents.ts';

function makeEvent(overrides: Partial<SeasonChangeEvent> = {}): SeasonChangeEvent {
  const targetId = overrides.targetId ?? 'LEG-1';
  const serverSeq = 'serverSeq' in overrides ? overrides.serverSeq ?? null : 101;
  return {
    eventId: overrides.eventId ?? `event-${serverSeq ?? 'missing'}`,
    seasonId: overrides.seasonId ?? 'season-1',
    clientId: overrides.clientId ?? 'client-a',
    opId: overrides.opId ?? `op-${serverSeq ?? 'missing'}`,
    serverSeq,
    targetType: overrides.targetType ?? 'modification',
    targetId,
    changedFields: overrides.changedFields ?? ['gate'],
    opPayload: overrides.opPayload ?? {
      type: 'modification',
      mod: { legId: targetId, action: 'modified', gate: 4 },
    },
    createdAt: overrides.createdAt ?? '2026-08-16T08:00:00.000Z',
  };
}

test('classifies a complete next modification event for direct patching', () => {
  const cursor = createSeasonRealtimeCursor('season-1', 100);
  assert.deepEqual(classifySeasonRealtimeEvent(makeEvent(), cursor), {
    kind: 'direct-modification',
    serverSeq: 101,
    legId: 'LEG-1',
    modification: { legId: 'LEG-1', action: 'modified', gate: 4 },
  });
});

test('ignores duplicate and stale server sequences even when arrival order is reversed', () => {
  const cursor = createSeasonRealtimeCursor('season-1', 102, {
    appliedEventIds: ['event-102'],
    appliedOpIds: ['op-102'],
  });
  assert.deepEqual(classifySeasonRealtimeEvent(makeEvent({ serverSeq: 101 }), cursor), {
    kind: 'ignore-duplicate-or-stale',
    serverSeq: 101,
  });
  assert.deepEqual(classifySeasonRealtimeEvent(makeEvent({ serverSeq: 102 }), cursor), {
    kind: 'ignore-duplicate-or-stale',
    serverSeq: 102,
  });
});

test('routes sequence gaps and unsafe payloads to background revalidation', () => {
  assert.deepEqual(
    classifySeasonRealtimeEvent(makeEvent({ serverSeq: 104 }), createSeasonRealtimeCursor('season-1', 101)),
    { kind: 'revalidate-window', reason: 'gap', serverSeq: 104 },
  );
  assert.deepEqual(
    classifySeasonRealtimeEvent(makeEvent({ serverSeq: null }), createSeasonRealtimeCursor('season-1', 101)),
    { kind: 'revalidate-window', reason: 'missing-sequence', serverSeq: null },
  );
  assert.deepEqual(
    classifySeasonRealtimeEvent(
      makeEvent({ opPayload: { type: 'modification', mod: { legId: 'OTHER', action: 'modified', gate: 5 } } }),
      createSeasonRealtimeCursor('season-1', 100),
    ),
    { kind: 'revalidate-window', reason: 'incomplete-payload', serverSeq: 101 },
  );
  assert.deepEqual(
    classifySeasonRealtimeEvent(
      makeEvent({ opPayload: { type: 'modificationDelete', legId: 'LEG-1' } }),
      createSeasonRealtimeCursor('season-1', 100),
    ),
    { kind: 'revalidate-window', reason: 'membership-change', serverSeq: 101 },
  );
  assert.deepEqual(
    classifySeasonRealtimeEvent(makeEvent({ targetType: 'flightRecord' }), createSeasonRealtimeCursor('season-1', 100)),
    { kind: 'revalidate-window', reason: 'unknown-target', serverSeq: 101 },
  );
});

test('does not use an event cursor from another season', () => {
  assert.deepEqual(
    classifySeasonRealtimeEvent(makeEvent({ seasonId: 'season-2' }), createSeasonRealtimeCursor('season-1', 100)),
    { kind: 'revalidate-window', reason: 'unknown-target', serverSeq: 101 },
  );
});

test('advances through non-visual history events without forcing a Gantt reload', () => {
  assert.deepEqual(
    classifySeasonRealtimeEvent(
      makeEvent({
        targetType: 'modHistory',
        targetId: 'history-1',
        opPayload: { type: 'modHistory', entry: { id: 'history-1', timestamp: 1, description: 'Gate', changes: [] } },
      }),
      createSeasonRealtimeCursor('season-1', 100),
    ),
    { kind: 'ignore-nonvisual', serverSeq: 101 },
  );
});
