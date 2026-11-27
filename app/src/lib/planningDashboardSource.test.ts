import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePlanningKpi,
  loadDashboardOverviewSource,
  loadSeasonalPlanningSource,
  loadFullSeasonalDraftSource,
  loadFullSeasonalPublishedSource,
} from './planningDashboardSource.ts';
import type { SeasonalDraftRecord } from './seasonalPlanningContract.ts';
import type { FlightRecord, FlightModification } from './types.ts';

function makeFlight(override: Partial<SeasonalDraftRecord>): SeasonalDraftRecord {
  return {
    draft_id: override.draft_id || crypto.randomUUID(),
    season_id: 'season-w26',
    link_id: 'link-1',
    type: override.type || 'D',
    airline: override.airline || 'VN',
    flight_number: override.flight_number || '101',
    route: override.route || 'SGN-HAN',
    schedule: override.schedule || '10:00',
    date: override.date || '2026-10-15',
    aircraft: override.aircraft || 'A321',
    category: 'J',
    status: override.status || 'active',
    action: override.action || null,
    scheduled_date: override.scheduled_date ?? override.date ?? '2026-10-15',
    scheduled_time: override.scheduled_time ?? override.schedule ?? '10:00',
    ...override,
  };
}

test('computePlanningKpi computes accurate pure planning aggregates from same-source dataset', () => {
  const flights: SeasonalDraftRecord[] = [
    makeFlight({ draft_id: 'f1', type: 'D', airline: 'VN', route: 'SGN-HAN', date: '2026-10-15' }),
    makeFlight({ draft_id: 'f2', type: 'A', airline: 'VN', route: 'HAN-SGN', date: '2026-10-15' }),
    makeFlight({ draft_id: 'f3', type: 'D', airline: 'VJ', route: 'SGN-DAD', date: '2026-10-15' }),
    makeFlight({ draft_id: 'f4', type: 'D', airline: 'QH', route: 'SGN-CXR', date: '2026-10-16' }),
    makeFlight({ draft_id: 'f5', type: 'D', airline: 'VN', route: 'SGN-HAN', date: '2026-10-16', status: 'deleted' }),
  ];

  const kpi = computePlanningKpi(flights);
  assert.equal(kpi.totalLegs, 4, 'Deleted flight f5 is excluded');
  assert.equal(kpi.depLegs, 3);
  assert.equal(kpi.arrLegs, 1);
  assert.equal(kpi.uniqueAirlines, 3, 'VN, VJ, QH');
  assert.equal(kpi.uniqueRoutes, 4, 'SGN-HAN, HAN-SGN, SGN-DAD, SGN-CXR');
  assert.equal(kpi.peakDay?.date, '2026-10-15');
  assert.equal(kpi.peakDay?.count, 3);
});

test('loadFullSeasonalDraftSource enforces epoch/revision fencing and cursor validation', async () => {
  let callCount = 0;
  const mockTransport = async (input: { afterDraftId?: string | null }) => {
    callCount++;
    if (!input.afterDraftId) {
      return {
        status: 'ok' as const,
        revision: '10',
        epoch: 'epoch-1',
        serverHighWater: '1',
        drafts: [makeFlight({ draft_id: 'd1' })],
        hasMore: true,
        nextDraftId: 'cursor-page-2',
      };
    }
    return {
      status: 'ok' as const,
      revision: '10',
      epoch: 'epoch-1',
      serverHighWater: '2',
      drafts: [makeFlight({ draft_id: 'd2' })],
      hasMore: false,
      nextDraftId: null,
    };
  };

  const res = await loadFullSeasonalDraftSource({
    seasonId: 'season-w26',
    expectedEpoch: 'epoch-1',
    expectedRevision: '10',
    transportFn: mockTransport,
  });

  assert.equal(callCount, 2);
  assert.equal(res.flights.length, 2);
  assert.equal(res.epoch, 'epoch-1');
  assert.equal(res.revision, '10');
});

test('loadFullSeasonalDraftSource detects cursor loop and throws', async () => {
  const loopingTransport = async () => ({
    status: 'ok' as const,
    revision: '1',
    epoch: 'ep1',
    serverHighWater: '1',
    drafts: [makeFlight({ draft_id: 'd1' })],
    hasMore: true,
    nextDraftId: 'same-cursor',
  });

  await assert.rejects(
    async () => {
      await loadFullSeasonalDraftSource({
        seasonId: 'season-w26',
        transportFn: loopingTransport,
      });
    },
    /phát hiện lặp cursor/
  );
});

test('loadFullSeasonalPublishedSource verifies versionId and checksum across pages', async () => {
  const mockPubTransport = async (input: { afterDraftId?: string | null }) => {
    if (!input.afterDraftId) {
      return {
        versionId: 'v1',
        seasonId: 's1',
        seasonCode: 'W26',
        checksum: 'chk-123',
        totalCount: 2,
        flights: [makeFlight({ draft_id: 'p1' })],
        hasMore: true,
        nextDraftId: 'p2-cursor',
      };
    }
    return {
      versionId: 'v1',
      seasonId: 's1',
      seasonCode: 'W26',
      checksum: 'chk-123',
      totalCount: 2,
      flights: [makeFlight({ draft_id: 'p2' })],
      hasMore: false,
      nextDraftId: null,
    };
  };

  const pubRes = await loadFullSeasonalPublishedSource({
    versionId: 'v1',
    transportFn: mockPubTransport,
  });

  assert.equal(pubRes.flights.length, 2);
  assert.equal(pubRes.checksum, 'chk-123');
  assert.equal(pubRes.versionId, 'v1');
});

test('loadFullSeasonalPublishedSource detects checksum drift across pages and throws', async () => {
  const driftingTransport = async (input: { afterDraftId?: string | null }) => {
    if (!input.afterDraftId) {
      return {
        versionId: 'v1',
        seasonId: 's1',
        seasonCode: 'W26',
        checksum: 'chk-initial',
        totalCount: 2,
        flights: [makeFlight({ draft_id: 'p1' })],
        hasMore: true,
        nextDraftId: 'p2-cursor',
      };
    }
    return {
      versionId: 'v1',
      seasonId: 's1',
      seasonCode: 'W26',
      checksum: 'chk-drifted',
      totalCount: 2,
      flights: [makeFlight({ draft_id: 'p2' })],
      hasMore: false,
      nextDraftId: null,
    };
  };

  await assert.rejects(
    async () => {
      await loadFullSeasonalPublishedSource({
        versionId: 'v1',
        transportFn: driftingTransport,
      });
    }
  );
});

test('loadFullSeasonalDraftSource retries from page 0 on mid-flight revision conflict', async () => {
  let attempt = 0;
  const conflictThenSuccessTransport = async (input: { afterDraftId?: string | null }) => {
    attempt++;
    if (attempt === 1) {
      // First page on attempt 1
      return {
        status: 'ok' as const,
        revision: '1',
        epoch: 'ep1',
        serverHighWater: '1',
        drafts: [makeFlight({ draft_id: 'd1' })],
        hasMore: true,
        nextDraftId: 'c2',
      };
    }
    if (attempt === 2) {
      // The RPC explicitly refuses a page when the pinned revision changed.
      return {
        status: 'snapshot_changed' as const,
        revision: '2',
        epoch: 'ep1',
        serverHighWater: '2',
        drafts: [],
        hasMore: false,
        nextDraftId: null,
      };
    }
    // Attempt 3 starts over from page 0
    return {
      status: 'ok' as const,
      revision: '2',
      epoch: 'ep1',
      serverHighWater: '2',
      drafts: [makeFlight({ draft_id: 'd1-fresh' }), makeFlight({ draft_id: 'd2-fresh' })],
      hasMore: false,
      nextDraftId: null,
    };
  };

  const res = await loadFullSeasonalDraftSource({
    seasonId: 'season-w26',
    transportFn: conflictThenSuccessTransport,
  });

  assert.equal(attempt, 3, 'Retried after detecting revision conflict mid-flight');
  assert.deepEqual(res.flights.map((flight) => flight.draft_id), ['d1-fresh', 'd2-fresh']);
  assert.equal(res.revision, '2');
});

test('loadFullSeasonalDraftSource deduplicates records across pages safely', async () => {
  const duplicatePageTransport = async (input: { afterDraftId?: string | null }) => {
    if (!input.afterDraftId) {
      return {
        status: 'ok' as const,
        revision: '1',
        epoch: 'ep1',
        serverHighWater: '1',
        drafts: [makeFlight({ draft_id: 'dup-1' }), makeFlight({ draft_id: 'dup-2' })],
        hasMore: true,
        nextDraftId: 'c2',
      };
    }
    return {
      status: 'ok' as const,
      revision: '1',
      epoch: 'ep1',
      serverHighWater: '2',
      drafts: [makeFlight({ draft_id: 'dup-2' }), makeFlight({ draft_id: 'dup-3' })],
      hasMore: false,
      nextDraftId: null,
    };
  };

  const res = await loadFullSeasonalDraftSource({
    seasonId: 's1',
    transportFn: duplicatePageTransport,
  });

  assert.equal(res.flights.length, 3, 'dup-2 is deduplicated');
});

test('loadSeasonalPlanningSource handles published vs draft dispatch cleanly', async () => {
  const loadResult = await loadSeasonalPlanningSource({
    seasonId: 's1',
    sourceKind: 'draft',
    draftTransportFn: async () => ({
      status: 'ok',
      revision: '5',
      epoch: 'ep-test',
      serverHighWater: '1',
      drafts: [makeFlight({ draft_id: 'dr1' })],
      hasMore: false,
    }),
  });

  assert.equal(loadResult.status, 'success');
  assert.equal(loadResult.identity.sourceKind, 'draft');
  assert.equal(loadResult.identity.draftRevision, '5');
  assert.equal(loadResult.flights.length, 1);
});

test('legacy dashboard mode reads effective workspace records without calling planning V1', async () => {
  const legacyRecord = {
    id: 'legacy-1',
    draftId: 'legacy-draft-1',
    linkId: 'link-1',
    type: 'D',
    airline: 'VN',
    flightNumber: '101',
    rawFlightNumber: 'VN101',
    requestStatusCode: null,
    route: 'SGN-HAN',
    schedule: '10:00',
    aircraft: 'A321',
    category: 'J',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: 'D',
    pax: 10,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-10-15',
    scheduledDate: '2026-10-15',
    scheduledTime: '10:00',
    dayOfWeek: 4,
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'seasonal',
    sourceSide: 'DEP',
    status: 'active',
  } as FlightRecord;
  const deletedRecord = { ...legacyRecord, id: 'deleted', draftId: undefined };
  const modifications = new Map<string, FlightModification>([
    ['legacy-1', { legId: 'legacy-1', action: 'modified', schedule: '11:00', pax: 25 }],
    ['deleted', { legId: 'deleted', action: 'deleted' }],
  ]);
  let legacyCalls = 0;
  let planningCalls = 0;

  const result = await loadDashboardOverviewSource({
    seasonId: 'season-1',
    planningV1Enabled: false,
    sourceKind: 'draft',
    legacyTransportFn: async () => {
      legacyCalls += 1;
      return { records: [legacyRecord, deletedRecord], modifications };
    },
    draftTransportFn: async () => {
      planningCalls += 1;
      throw new Error('must not call planning V1 in legacy mode');
    },
  });

  assert.equal(legacyCalls, 1);
  assert.equal(planningCalls, 0);
  assert.equal(result.status, 'success');
  assert.equal(result.identity.sourceKind, 'draft');
  assert.equal(result.flights.length, 1);
  assert.equal(result.flights[0]?.schedule, '11:00');
  assert.equal(result.flights[0]?.pax, 25);
  assert.equal(result.flights[0]?.status, 'active');
});

test('planning V1 dashboard mode never falls back to legacy workspace on RPC errors', async () => {
  let legacyCalls = 0;
  await assert.rejects(
    loadDashboardOverviewSource({
      seasonId: 'season-1',
      planningV1Enabled: true,
      sourceKind: 'draft',
      draftTransportFn: async () => {
        throw new Error('permission denied');
      },
      legacyTransportFn: async () => {
        legacyCalls += 1;
        return { records: [], modifications: new Map() };
      },
    }),
    /permission denied/,
  );
  assert.equal(legacyCalls, 0);
});
