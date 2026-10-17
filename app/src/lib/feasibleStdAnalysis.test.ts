import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FEASIBLE_STD_PARAMS,
  analyzeDayFeasibleStd,
  buildDemandSegments,
  evaluateArbitraryCandidateStd,
  evaluateCandidateStdAtEpochMs,
  extractActiveDepFlights,
  extractActiveDepFlightsDetailed,
  findMaxDemandInWindow,
  normalizeDraftFlightToStdFlight,
  parseVietnamDateTimeToEpochMs,
  resolveOpsDate,
  validateFeasibleStdParams,
} from './feasibleStdAnalysis.ts';
import type { SeasonalDraftRecord } from './seasonalPlanningContract.ts';

function createMockDraft(override: Partial<SeasonalDraftRecord>): SeasonalDraftRecord {
  return {
    draft_id: override.draft_id || crypto.randomUUID(),
    season_id: 'season-w26',
    link_id: 'link-1',
    type: override.type || 'D',
    airline: override.airline || 'VN',
    flight_number: override.flight_number || '101',
    route: 'SGN-HAN',
    schedule: override.schedule || '10:00',
    date: override.date || '2026-10-15',
    aircraft: 'A321',
    category: 'J',
    status: override.status || 'active',
    action: override.action || null,
    scheduled_date: override.scheduled_date ?? override.date ?? '2026-10-15',
    scheduled_time: override.scheduled_time ?? override.schedule ?? '10:00',
    ...override,
  };
}

test('resolveOpsDate correctly applies 05:00 cutoff', () => {
  // Flight at 01:30 belongs to previous ops day
  assert.equal(resolveOpsDate('2026-10-16', '01:30', '05:00'), '2026-10-15');
  // Flight at 04:59 belongs to previous ops day
  assert.equal(resolveOpsDate('2026-10-16', '04:59', '05:00'), '2026-10-15');
  // Flight at exactly 05:00 belongs to the new ops day
  assert.equal(resolveOpsDate('2026-10-16', '05:00', '05:00'), '2026-10-16');
  // Flight at 14:00 belongs to the same ops day
  assert.equal(resolveOpsDate('2026-10-16', '14:00', '05:00'), '2026-10-16');
});

test('normalizeDraftFlightToStdFlight filters ARR, deleted, cancelled and extracts active DEP', () => {
  // ARR flight should be ignored
  assert.equal(normalizeDraftFlightToStdFlight(createMockDraft({ type: 'A' })), null);

  // Deleted flight should be ignored
  assert.equal(normalizeDraftFlightToStdFlight(createMockDraft({ status: 'deleted' })), null);
  assert.equal(normalizeDraftFlightToStdFlight(createMockDraft({ action: 'deleted' })), null);

  // Cancelled flight should be ignored
  assert.equal(normalizeDraftFlightToStdFlight(createMockDraft({ request_status_code: 'CNL' })), null);

  // Active DEP flight
  const norm = normalizeDraftFlightToStdFlight(createMockDraft({
    type: 'D',
    date: '2026-10-15',
    schedule: '10:00',
  }));
  assert.ok(norm);
  assert.equal(norm.scheduledDate, '2026-10-15');
  assert.equal(norm.scheduledTime, '10:00');
  assert.equal(norm.opsDate, '2026-10-15');

  // slot window: [10:00 - 180m, 10:00 - 50m) = [07:00, 09:10)
  const slotDurationMinutes = (norm.slotEndEpochMs - norm.slotStartEpochMs) / 60_000;
  assert.equal(slotDurationMinutes, 130);
});

test('deduplication ignores duplicate draft_id records', () => {
  const f1 = createMockDraft({ draft_id: 'draft-unique-1', schedule: '10:00' });
  const f2 = createMockDraft({ draft_id: 'draft-unique-1', schedule: '10:00' }); // duplicate
  const f3 = createMockDraft({ draft_id: 'draft-unique-2', schedule: '11:00' });

  const active = extractActiveDepFlights([f1, f2, f3]);
  assert.equal(active.length, 2);
});

test('exact event sweep half-open window: start inclusive, end exclusive, end-before-start tie', () => {
  // Flight A: STD 10:00 -> slot window [07:00, 09:10)
  // Flight B: STD 12:20 -> slot window [09:10, 11:30) (since 12:20 - 180 min = 09:10)
  const fA = normalizeDraftFlightToStdFlight(createMockDraft({ draft_id: 'A', schedule: '10:00' }))!;
  const fB = normalizeDraftFlightToStdFlight(createMockDraft({ draft_id: 'B', schedule: '12:20' }))!;

  const segments = buildDemandSegments([fA, fB]);

  // Between 07:00 and 09:10: demand 1
  // At 09:10: Flight A ends (-1), Flight B starts (+1). Demand stays 1, never spikes to 2!
  for (const seg of segments) {
    assert.equal(seg.demand, 1, 'Demand should remain 1, never spike to 2 at 09:10');
  }

  // Exact window query covering 09:10
  const t0900 = parseVietnamDateTimeToEpochMs('2026-10-15', '09:00')!;
  const t0920 = parseVietnamDateTimeToEpochMs('2026-10-15', '09:20')!;
  const result = findMaxDemandInWindow(segments, t0900, t0920);
  assert.equal(result.maxDemand, 1);
});

test('status boundaries: M=0, 12, 13, 14 maps to green/amber/red and canAddOne', () => {
  const makeCohort = (count: number, schedule = '10:00') =>
    Array.from({ length: count }, (_, i) =>
      createMockDraft({ draft_id: `f-${count}-${i}`, schedule })
    );

  // M = 0
  const seg0 = buildDemandSegments([]);
  const eval0 = evaluateCandidateStdAtEpochMs(
    seg0,
    parseVietnamDateTimeToEpochMs('2026-10-15', '10:00')!,
    DEFAULT_FEASIBLE_STD_PARAMS
  );
  assert.equal(eval0.maxDemand, 0);
  assert.equal(eval0.status, 'green');
  assert.equal(eval0.remaining, 13);
  assert.equal(eval0.projectedMax, 1);
  assert.equal(eval0.canAddOne, true);

  // M = 12
  const seg12 = buildDemandSegments(extractActiveDepFlights(makeCohort(12, '10:00')));
  const eval12 = evaluateCandidateStdAtEpochMs(
    seg12,
    parseVietnamDateTimeToEpochMs('2026-10-15', '10:00')!,
    DEFAULT_FEASIBLE_STD_PARAMS
  );
  assert.equal(eval12.maxDemand, 12);
  assert.equal(eval12.status, 'green');
  assert.equal(eval12.remaining, 1);
  assert.equal(eval12.projectedMax, 13);
  assert.equal(eval12.canAddOne, true);

  // M = 13 (threshold reached)
  const seg13 = buildDemandSegments(extractActiveDepFlights(makeCohort(13, '10:00')));
  const eval13 = evaluateCandidateStdAtEpochMs(
    seg13,
    parseVietnamDateTimeToEpochMs('2026-10-15', '10:00')!,
    DEFAULT_FEASIBLE_STD_PARAMS
  );
  assert.equal(eval13.maxDemand, 13);
  assert.equal(eval13.status, 'amber');
  assert.equal(eval13.remaining, 0);
  assert.equal(eval13.projectedMax, 14);
  assert.equal(eval13.canAddOne, false);

  // M = 14 (over threshold)
  const seg14 = buildDemandSegments(extractActiveDepFlights(makeCohort(14, '10:00')));
  const eval14 = evaluateCandidateStdAtEpochMs(
    seg14,
    parseVietnamDateTimeToEpochMs('2026-10-15', '10:00')!,
    DEFAULT_FEASIBLE_STD_PARAMS
  );
  assert.equal(eval14.maxDemand, 14);
  assert.equal(eval14.status, 'red');
  assert.equal(eval14.remaining, 0);
  assert.equal(eval14.projectedMax, 15);
  assert.equal(eval14.canAddOne, false);
});

test('off-grid peak regression (§3.3) detected by exact event sweep', () => {
  // Two cohorts of 13 flights:
  // Cohort A: STD 10:52 -> window [07:52, 10:02)
  // Cohort B: STD 13:01 -> window [10:01, 12:11)
  // Overlap occurs strictly between [10:01, 10:02) where demand = 26!
  // A 5-minute sampling grid checking 10:00 and 10:05 would only see 13.
  const cohortA = Array.from({ length: 13 }, (_, i) =>
    createMockDraft({ draft_id: `A-${i}`, schedule: '10:52' })
  );
  const cohortB = Array.from({ length: 13 }, (_, i) =>
    createMockDraft({ draft_id: `B-${i}`, schedule: '13:01' })
  );

  const active = extractActiveDepFlights([...cohortA, ...cohortB]);
  const segments = buildDemandSegments(active);

  // Verify that an exact segment with demand 26 exists
  const peakSegment = segments.find((s) => s.demand === 26);
  assert.ok(peakSegment, 'Exact segment with demand=26 must be present');

  // Candidate whose window covers [10:01, 10:02), e.g. STD 11:50 -> window [08:50, 11:00)
  const tStart = parseVietnamDateTimeToEpochMs('2026-10-15', '08:50')!;
  const tEnd = parseVietnamDateTimeToEpochMs('2026-10-15', '11:00')!;
  const peak = findMaxDemandInWindow(segments, tStart, tEnd);
  assert.equal(peak.maxDemand, 26);
});

test('single flight day generates candidate range [min_STD - 30, max_STD + 30] step 5', () => {
  const flight = createMockDraft({ date: '2026-10-15', schedule: '10:02' });
  const result = analyzeDayFeasibleStd([flight], '2026-10-15', { stepMinutes: 5, stdRangeBufferMinutes: 30 });

  assert.equal(result.hasFlights, true);
  assert.equal(result.countedDepFlights, 1);
  // 09:32 through 10:32, preserving the off-grid origin: 13 points at 5-minute intervals.
  assert.equal(result.candidates.length, 13);
  assert.equal(result.candidates[0].stdLabel, '09:32');
  assert.equal(result.candidates[result.candidates.length - 1].stdLabel, '10:32');
});

test('empty day returns empty candidates and hasFlights = false', () => {
  const flightOtherDay = createMockDraft({ date: '2026-10-14', schedule: '10:00' });
  const result = analyzeDayFeasibleStd([flightOtherDay], '2026-10-15');

  assert.equal(result.hasFlights, false);
  assert.equal(result.countedDepFlights, 0);
  assert.equal(result.candidates.length, 0);
});

test('cross-day demand overlap: previous day flight window affects current day candidate', () => {
  // Flight on day 2026-10-15 with STD 06:00 -> window [03:00, 05:10).
  // Flight on day 2026-10-14 with STD 23:00 -> window [20:00, 22:10).
  // Flight on day 2026-10-14 with STD 07:00 (next day morning 01:30 Ops Day 14) -> STD 01:30 of 15th:
  // STD 01:30 on 15th has opsDate = 2026-10-14, window [22:30 on 14th, 00:40 on 15th).
  // Let's create a late flight on Ops Day 14 with STD 04:30 on 15th:
  // scheduledDate = '2026-10-15', scheduledTime = '04:30' -> opsDate = '2026-10-14'.
  // slot window: [01:30, 03:40) on 2026-10-15.
  // And on Ops Day 15: flight with STD '06:00' -> window [03:00, 05:10) on 2026-10-15.
  // Overlap between [03:00, 03:40) on 2026-10-15 where both flights are active simultaneously!
  const flightD14 = createMockDraft({
    draft_id: 'f-ops14',
    date: '2026-10-15',
    schedule: '04:30', // Ops Date = 2026-10-14
  });
  const flightD15 = createMockDraft({
    draft_id: 'f-ops15',
    date: '2026-10-15',
    schedule: '06:00', // Ops Date = 2026-10-15
  });

  // Analyze Ops Day 2026-10-15:
  const resultD15 = analyzeDayFeasibleStd([flightD14, flightD15], '2026-10-15');
  assert.equal(resultD15.hasFlights, true);
  assert.equal(resultD15.countedDepFlights, 1, 'Only flight with opsDate=15 belongs to day cohort');

  // Candidate STD 06:00 has window [03:00, 05:10).
  // In [03:00, 03:40), flightD14 is ALSO active!
  // So maxDemand in window [03:00, 05:10) must be 2!
  const cand0600 = resultD15.candidates.find((c) => c.stdLabel === '06:00');
  assert.ok(cand0600);
  assert.equal(cand0600.maxDemand, 2, 'Cross-day overlap from flightD14 correctly included');
});

test('evaluateArbitraryCandidateStd evaluates exact time without rounding to 5-minute grid', () => {
  const flight = createMockDraft({ date: '2026-10-15', schedule: '10:00' }); // window [07:00, 09:10)
  const assessment = evaluateArbitraryCandidateStd([flight], '2026-10-15T09:37:00');

  assert.equal(assessment.candidate.candidateStd, '2026-10-15T09:37:00');
  assert.equal(assessment.candidate.stdLabel, '09:37');
  assert.equal(assessment.candidate.windowStart, '2026-10-15T06:37:00');
  assert.equal(assessment.candidate.windowEnd, '2026-10-15T08:47:00');
  // [06:37, 08:47) overlaps with [07:00, 09:10) -> maxDemand = 1
  assert.equal(assessment.candidate.maxDemand, 1);
  assert.equal(assessment.candidate.status, 'green');
  assert.equal(assessment.candidate.canAddOne, true);
  assert.ok(assessment.explanation.includes('Khả thi'));
});


test('validateFeasibleStdParams enforces required constraints and fixed cutoff', () => {
  assert.doesNotThrow(() => {
    validateFeasibleStdParams(DEFAULT_FEASIBLE_STD_PARAMS);
  });

  assert.throws(() => {
    validateFeasibleStdParams({ ...DEFAULT_FEASIBLE_STD_PARAMS, opsDayCutoffTime: '06:00' as '05:00' });
  });

  assert.throws(() => {
    validateFeasibleStdParams({ ...DEFAULT_FEASIBLE_STD_PARAMS, threshold: 0 });
  });

  assert.throws(() => {
    validateFeasibleStdParams({ ...DEFAULT_FEASIBLE_STD_PARAMS, stepMinutes: 0 });
  });
});

test('codeshares on same date, time and route are deduplicated to single processing slot', () => {
  const opFlight = createMockDraft({
    draft_id: 'op-1',
    airline: 'VN',
    flight_number: '123',
    date: '2026-10-15',
    schedule: '10:00',
    route: 'SGN-HAN',
    code_shares: 'AF456, DL789',
  });

  const csFlight = createMockDraft({
    draft_id: 'cs-1',
    airline: 'AF',
    flight_number: '456',
    date: '2026-10-15',
    schedule: '10:00',
    route: 'SGN-HAN',
  });

  const { flights } = extractActiveDepFlightsDetailed([opFlight, csFlight]);
  assert.equal(flights.length, 1, 'Operating flight and marketing codeshare deduplicate to 1 slot');
  assert.equal(flights[0].recordId, 'op-1');
});

test('malformed scheduled datetime marks analysis as incomplete', () => {
  const malformedFlight = createMockDraft({
    draft_id: 'bad-1',
    date: '2026-99-99',
    schedule: '99:99',
  });

  const result = analyzeDayFeasibleStd([malformedFlight], '2026-10-15');
  assert.equal(result.isIncomplete, true);
  assert.ok(result.incompleteReason?.includes('không hợp lệ'));
});
