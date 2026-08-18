import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGanttInteractionArbiter,
  findLatestSequencedModificationPatch,
  type GanttTargetKey,
  type SequencedModificationPatch,
} from './ganttInteractionArbiter.ts';

const targetA: GanttTargetKey = { seasonId: 'season-1', targetType: 'modification', targetId: 'LEG-A' };
const targetB: GanttTargetKey = { seasonId: 'season-1', targetType: 'modification', targetId: 'LEG-B' };

function patch(targetId: string, serverSeq: number, source: SequencedModificationPatch['source'] = 'remote'): SequencedModificationPatch {
  return {
    serverSeq,
    source,
    modification: { legId: targetId, action: 'modified', gate: serverSeq },
  };
}

test('queues only the active target and applies another target immediately', () => {
  const arbiter = createGanttInteractionArbiter();
  arbiter.begin(targetA);
  assert.deepEqual(arbiter.enqueueOrApply(targetA, patch('LEG-A', 102)), { kind: 'queued' });
  assert.deepEqual(arbiter.enqueueOrApply(targetB, patch('LEG-B', 103)), {
    kind: 'apply',
    candidate: patch('LEG-B', 103),
  });
});

test('settle returns the highest server sequence regardless of arrival order', () => {
  const arbiter = createGanttInteractionArbiter();
  arbiter.begin(targetA);
  arbiter.enqueueOrApply(targetA, patch('LEG-A', 104));
  arbiter.enqueueOrApply(targetA, patch('LEG-A', 102));
  assert.deepEqual(arbiter.settle(targetA, patch('LEG-A', 103, 'local-ack')), patch('LEG-A', 104));
  assert.equal(arbiter.isActive(targetA), false);

  arbiter.begin(targetA);
  arbiter.enqueueOrApply(targetA, patch('LEG-A', 105));
  assert.deepEqual(arbiter.settle(targetA, patch('LEG-A', 106, 'local-ack')), patch('LEG-A', 106, 'local-ack'));
});

test('cancel releases the interaction and returns the newest queued remote patch', () => {
  const arbiter = createGanttInteractionArbiter();
  arbiter.begin(targetA);
  arbiter.enqueueOrApply(targetA, patch('LEG-A', 102));
  assert.deepEqual(arbiter.cancel(targetA), patch('LEG-A', 102));
  assert.equal(arbiter.isActive(targetA), false);
});

test('disposeSeason clears only matching season locks and queued patches', () => {
  const arbiter = createGanttInteractionArbiter();
  const otherSeason = { ...targetA, seasonId: 'season-2' };
  arbiter.begin(targetA);
  arbiter.begin(otherSeason);
  arbiter.enqueueOrApply(targetA, patch('LEG-A', 102));
  arbiter.enqueueOrApply(otherSeason, patch('LEG-A', 103));
  arbiter.disposeSeason('season-1');
  assert.equal(arbiter.isActive(targetA), false);
  assert.equal(arbiter.cancel(targetA), null);
  assert.equal(arbiter.isActive(otherSeason), true);
  assert.deepEqual(arbiter.cancel(otherSeason), patch('LEG-A', 103));
});

test('finds the newest canonical modification acknowledgement for one target', () => {
  const base = {
    seasonId: 'season-1',
    clientId: 'client-a',
    actorUserId: null,
    changedFields: ['gate'],
    createdAt: '2026-08-16T08:00:00.000Z',
  };
  const result = findLatestSequencedModificationPatch([
    {
      ...base,
      eventId: 'event-101',
      opId: 'op-101',
      serverSeq: 101,
      targetType: 'modification',
      targetId: 'LEG-A',
      opPayload: { type: 'modification', mod: { legId: 'LEG-A', action: 'modified', gate: 4 } },
    },
    {
      ...base,
      eventId: 'event-103',
      opId: 'op-103',
      serverSeq: 103,
      targetType: 'modification',
      targetId: 'LEG-A',
      opPayload: { type: 'modification', mod: { legId: 'LEG-A', action: 'modified', gate: 8 } },
    },
  ], 'LEG-A', 'local-ack');
  assert.deepEqual(result, {
    serverSeq: 103,
    source: 'local-ack',
    modification: { legId: 'LEG-A', action: 'modified', gate: 8 },
  });
});

test('ignores an incomplete mutation acknowledgement so the caller can revalidate', () => {
  const incompleteEvent = {
    eventId: 'event-incomplete',
    seasonId: 'season-1',
    clientId: 'client-a',
    opId: 'op-incomplete',
    actorUserId: null,
    serverSeq: 107,
    targetType: 'modification',
    targetId: 'LEG-A',
    changedFields: ['counter'],
    createdAt: '2026-08-16T08:00:00.000Z',
  };

  assert.doesNotThrow(() => {
    assert.equal(findLatestSequencedModificationPatch(
      [incompleteEvent as never],
      'LEG-A',
      'local-ack',
    ), null);
  });
});

test('uses the submitted modification when an applied acknowledgement omits its payload', () => {
  const incompleteEvent = {
    eventId: 'event-incomplete',
    seasonId: 'season-1',
    clientId: 'client-a',
    opId: 'op-incomplete',
    actorUserId: null,
    serverSeq: 107,
    targetType: 'modification',
    targetId: 'LEG-A',
    changedFields: ['counter'],
    createdAt: '2026-08-16T08:00:00.000Z',
  };
  const submittedModification = {
    legId: 'LEG-A',
    action: 'modified' as const,
    counter: [21, 22],
  };

  const localAck = findLatestSequencedModificationPatch(
    [incompleteEvent as never],
    'LEG-A',
    'local-ack',
    submittedModification,
  );
  assert.deepEqual(localAck, {
    serverSeq: 107,
    source: 'local-ack',
    modification: submittedModification,
  });

  const arbiter = createGanttInteractionArbiter();
  const newerRemote = {
    serverSeq: 108,
    source: 'remote' as const,
    modification: { legId: 'LEG-A', action: 'modified' as const, counter: [31, 32] },
  };
  arbiter.begin(targetA);
  arbiter.enqueueOrApply(targetA, newerRemote);
  assert.deepEqual(arbiter.settle(targetA, localAck), newerRemote);
});

test('prefers a canonical acknowledgement payload over the submitted fallback', () => {
  const canonicalModification = { legId: 'LEG-A', action: 'modified' as const, counter: [41, 42] };
  const event = {
    eventId: 'event-canonical',
    seasonId: 'season-1',
    clientId: 'client-a',
    opId: 'op-canonical',
    actorUserId: null,
    serverSeq: 109,
    targetType: 'modification' as const,
    targetId: 'LEG-A',
    changedFields: ['counter'],
    opPayload: { type: 'modification' as const, mod: canonicalModification },
    createdAt: '2026-08-16T08:00:00.000Z',
  };

  assert.deepEqual(findLatestSequencedModificationPatch(
    [event],
    'LEG-A',
    'local-ack',
    { legId: 'LEG-A', action: 'modified', counter: [51, 52] },
  ), {
    serverSeq: 109,
    source: 'local-ack',
    modification: canonicalModification,
  });
});
