import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspaceWindowV2, WorkspaceWindowV2Error } from './seasonWorkspaceWindowV2Assembler.ts';

function page(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok', seasonId: 'S1', startDate: null, endDate: null, resourceType: 'all',
    snapshot: { dataVersion: 3, serverHighWater: 9 },
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    flightRecords: [{ record_id: 'R1' }], flightRecordCounters: [], flightRecordWindows: [],
    modifications: [], modificationCounters: [], modificationWindows: [], modificationAddedLegs: [],
    ...overrides,
  };
}

test('assembles sequential pages while pinning the accepted snapshot', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const result = await loadWorkspaceWindowV2({ seasonId: 'S1' }, {
    requestPage: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      return requests.length === 1
        ? page({ page: { returnedCount: 1, hasMore: true, nextCursor: { effectiveDate: '2026-01-01', rootId: 'R1', rootKind: 0 } } })
        : page({ flightRecords: [{ record_id: 'R2' }] });
    },
  });
  assert.deepEqual(result.flightRecords.map((row) => row.record_id), ['R1', 'R2']);
  assert.equal(result.page.returnedCount, 2);
  assert.deepEqual((requests[1].expectedSnapshot), { dataVersion: 3, serverHighWater: 9 });
});

test('discards a changed snapshot once, jitters, and restarts from page one', async () => {
  const cursors: unknown[] = [];
  const delays: number[] = [];
  let calls = 0;
  const result = await loadWorkspaceWindowV2({ seasonId: 'S1' }, {
    requestPage: async (request) => {
      cursors.push(request.cursor);
      calls += 1;
      if (calls === 2) return { status: 'snapshot_changed', snapshot: { dataVersion: 4, serverHighWater: 10 } };
      return calls === 1
        ? page({ page: { returnedCount: 1, hasMore: true, nextCursor: { effectiveDate: '2026-01-01', rootId: 'R1', rootKind: 0 } } })
        : page({ snapshot: { dataVersion: 4, serverHighWater: 10 }, flightRecords: [{ record_id: 'R3' }] });
    },
    delay: async (milliseconds) => { delays.push(milliseconds); },
    random: () => 0,
  });
  assert.deepEqual(cursors, [null, { effectiveDate: '2026-01-01', rootId: 'R1', rootKind: 0 }, null]);
  assert.deepEqual(delays, [250]);
  assert.deepEqual(result.flightRecords.map((row) => row.record_id), ['R3']);
});

test('fails after one automatic snapshot restart', async () => {
  await assert.rejects(
    loadWorkspaceWindowV2({ seasonId: 'S1' }, {
      requestPage: async () => ({ status: 'snapshot_changed', snapshot: { dataVersion: 4, serverHighWater: 10 } }),
      delay: async () => undefined,
    }),
    (error: unknown) => error instanceof WorkspaceWindowV2Error && error.code === 'SNAPSHOT_CHANGED',
  );
});

test('enforces the logical root limit without returning a partial snapshot', async () => {
  await assert.rejects(
    loadWorkspaceWindowV2({ seasonId: 'S1', limit: 1 }, {
      requestPage: async () => page({ page: { returnedCount: 1, hasMore: true, nextCursor: { effectiveDate: '2026-01-01', rootId: 'R1', rootKind: 0 } } }),
    }),
    (error: unknown) => error instanceof WorkspaceWindowV2Error && error.code === 'WINDOW_LIMIT_EXCEEDED',
  );
});

test('rejects duplicate relational keys across pages', async () => {
  let calls = 0;
  await assert.rejects(
    loadWorkspaceWindowV2({ seasonId: 'S1' }, {
      requestPage: async () => {
        calls += 1;
        return calls === 1
          ? page({ page: { returnedCount: 1, hasMore: true, nextCursor: { effectiveDate: '2026-01-01', rootId: 'R1', rootKind: 0 } } })
          : page();
      },
    }),
    (error: unknown) => error instanceof WorkspaceWindowV2Error && error.code === 'INVALID_PAGE_SEQUENCE',
  );
});
