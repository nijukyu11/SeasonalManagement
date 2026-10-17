/**
 * Feasible STD Analysis Engine (Pure TypeScript)
 *
 * Implements the Feasible STD capacity evaluation according to:
 * - docs/plans/dashboard_redesign_and_sidecar_removal_plan.md (§3-4, P2, acceptance)
 * - Feasible STD Specification v1.0
 *
 * Key business rules & guarantees:
 * 1. Only active DEP flights count as 1 processing slot. ARR, cancelled, deleted, and duplicates are excluded.
 * 2. Slot window W(f) = [STD(f) - slotBeforeMinutes, STD(f) - slotAfterMinutes), default [-180, -50) min.
 *    Semantics: half-open interval [start, end) — start inclusive, end exclusive.
 *    At coinciding end and start timestamps, end (-1) is processed before start (+1) to avoid false instantaneous spikes.
 * 3. Exact event sweep: computes exact maximum demand M(X) over [X - 180, X - 50) without 5-minute sampling error.
 * 4. Cross-day window overlap: includes all DEP flights in the same planning source whose processing window
 *    overlaps the evaluated candidate windows.
 * 5. Ops Day cutoff 05:00 UTC+7: flights with STD in [00:00, 05:00) belong to the previous operational day.
 * 6. Candidate grid: [min_STD - 30m, max_STD + 30m] at step 5m.
 * 7. Arbitrary candidate evaluation: evaluate any datetime directly without rounding to the 5-minute grid.
 * 8. Status classification:
 *    - green: M < 13
 *    - amber: M = 13
 *    - red: M > 13
 *    - remaining: max(0, threshold - M)
 *    - projectedMax: M + 1 (for adding 1 trial flight)
 *    - canAddOne: (M + 1 <= 13), i.e., M <= 12
 * 9. Clear distinction between valid empty day (0 flights), incomplete (season boundary / unparseable), and error.
 */

import type { SeasonalDraftRecord } from './seasonalPlanningContract.ts';

export function shiftVietnamIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export interface FeasibleStdParams {
  slotBeforeMinutes: number; // default: 180
  slotAfterMinutes: number;  // default: 50
  threshold: number;         // default: 13
  stepMinutes: number;       // default: 5
  stdRangeBufferMinutes: number; // default: 30
  opsDayCutoffTime: string;  // fixed: '05:00'
}

export const DEFAULT_FEASIBLE_STD_PARAMS: FeasibleStdParams = {
  slotBeforeMinutes: 180,
  slotAfterMinutes: 50,
  threshold: 13,
  stepMinutes: 5,
  stdRangeBufferMinutes: 30,
  opsDayCutoffTime: '05:00',
};

export function validateFeasibleStdParams(params: FeasibleStdParams): void {
  if (!Number.isInteger(params.slotBeforeMinutes) || params.slotBeforeMinutes < 1 || params.slotBeforeMinutes > 1440) {
    throw new Error(`slotBeforeMinutes must be a finite integer between 1 and 1440, got ${params.slotBeforeMinutes}`);
  }
  if (!Number.isInteger(params.slotAfterMinutes) || params.slotAfterMinutes < 0 || params.slotAfterMinutes >= params.slotBeforeMinutes) {
    throw new Error(`slotAfterMinutes must be a finite integer between 0 and slotBeforeMinutes - 1, got ${params.slotAfterMinutes}`);
  }
  if (!Number.isInteger(params.threshold) || params.threshold < 1 || params.threshold > 1000) {
    throw new Error(`threshold must be a finite integer between 1 and 1000, got ${params.threshold}`);
  }
  if (!Number.isInteger(params.stepMinutes) || params.stepMinutes < 1 || params.stepMinutes > 60) {
    throw new Error(`stepMinutes must be a finite integer between 1 and 60, got ${params.stepMinutes}`);
  }
  if (!Number.isInteger(params.stdRangeBufferMinutes) || params.stdRangeBufferMinutes < 0 || params.stdRangeBufferMinutes > 1440) {
    throw new Error(`stdRangeBufferMinutes must be a finite integer between 0 and 1440, got ${params.stdRangeBufferMinutes}`);
  }
  if (params.opsDayCutoffTime !== '05:00') {
    throw new Error(`opsDayCutoffTime must be fixed at '05:00', got ${params.opsDayCutoffTime}`);
  }
}

export type FeasibleStdStatus = 'green' | 'amber' | 'red';

export interface FeasibleStdNormalizedFlight {
  recordId: string;
  airline: string;
  flightNumber: string;
  scheduledDate: string; // 'YYYY-MM-DD'
  scheduledTime: string; // 'HH:mm'
  stdDateTimeIso: string; // 'YYYY-MM-DDTHH:mm:00'
  stdEpochMs: number;
  slotStartEpochMs: number;
  slotEndEpochMs: number;
  opsDate: string; // 'YYYY-MM-DD'
}

export interface FeasibleStdCandidatePoint {
  candidateStd: string;      // 'YYYY-MM-DDTHH:mm:00'
  stdLabel: string;          // 'HH:mm'
  windowStart: string;       // 'YYYY-MM-DDTHH:mm:00'
  windowEnd: string;         // 'YYYY-MM-DDTHH:mm:00'
  maxDemand: number;         // M(X) prior to adding trial flight
  peakAt: string;            // 'YYYY-MM-DDTHH:mm:00' (first moment reaching maxDemand)
  status: FeasibleStdStatus; // green (<13) | amber (=13) | red (>13)
  remaining: number;         // max(0, threshold - M)
  projectedMax: number;      // M + 1
  canAddOne: boolean;        // M + 1 <= threshold
}

export interface FeasibleStdAssessmentResult {
  candidate: FeasibleStdCandidatePoint;
  explanation: string;
}

export interface DayFeasibleStdResult {
  opsDate: string;
  params: FeasibleStdParams;
  candidates: FeasibleStdCandidatePoint[];
  countedDepFlights: number;
  overallMaxDemand: number;
  overallPeakAt: string | null;
  hasFlights: boolean;
  isIncomplete: boolean;
  incompleteReason?: string;
  candidateMinStdLabel?: string;
  candidateMaxStdLabel?: string;
}

export interface DemandSegment {
  start: number; // epoch ms
  end: number;   // epoch ms
  demand: number;
}

// ---------------------------------------------------------------------------
// Time & Datetime Helpers (Deterministic Asia/Ho_Chi_Minh UTC+7)
// ---------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH: readonly number[] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Converts a Vietnam calendar date YYYY-MM-DD and time HH:mm (or HH:mm:ss)
 * to an absolute epoch millisecond, with strict calendar and finite bounds validation.
 */
export function parseVietnamDateTimeToEpochMs(dateStr: string, timeStr: string): number | null {
  if (!dateStr || !timeStr) return null;
  const dClean = dateStr.trim();
  const tClean = timeStr.trim();

  // Strict calendar date format YYYY-MM-DD
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dClean);
  if (!dateMatch) return null;
  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);

  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  const maxDays = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month];
  if (day < 1 || day > maxDays) return null;

  // Strict time format HH:mm or HH:mm:ss (hours 0-23, minutes 0-59, seconds 0-59)
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(tClean);
  if (!timeMatch) return null;
  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null;

  // Compute UTC timestamp then subtract Vietnam offset (+7 hours)
  const utcMs = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return utcMs - VIETNAM_OFFSET_MS;
}
/**
 * Formats epoch ms into Vietnam local ISO datetime string: 'YYYY-MM-DDTHH:mm:00'
 */
export function formatEpochMsToVietnamIso(epochMs: number): string {
  const local = new Date(epochMs + VIETNAM_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  const h = String(local.getUTCHours()).padStart(2, '0');
  const min = String(local.getUTCMinutes()).padStart(2, '0');
  const s = String(local.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

/**
 * Formats epoch ms into Vietnam local time label: 'HH:mm'
 */
export function formatEpochMsToVietnamTimeLabel(epochMs: number): string {
  const local = new Date(epochMs + VIETNAM_OFFSET_MS);
  const h = String(local.getUTCHours()).padStart(2, '0');
  const min = String(local.getUTCMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/**
 * Resolves Ops Date according to cutoff time (05:00 UTC+7):
 * Flights with scheduled time < 05:00 belong to the previous operational date.
 */
export function resolveOpsDate(scheduledDate: string, scheduledTime: string, cutoffTime = '05:00'): string {
  const time = (scheduledTime || '00:00').slice(0, 5);
  return time < cutoffTime ? shiftVietnamIsoDate(scheduledDate, -1) : scheduledDate;
}

// ---------------------------------------------------------------------------
// Flight Normalization & Validation
// ---------------------------------------------------------------------------

/**
 * Normalizes a SeasonalDraftRecord into an active DEP processing flight.
 * Excludes ARR, cancelled/deleted/inactive, and unparseable records.
 */
export function normalizeDraftFlightToStdFlight(
  record: SeasonalDraftRecord,
  params: FeasibleStdParams = DEFAULT_FEASIBLE_STD_PARAMS
): FeasibleStdNormalizedFlight | null {
  // Only active DEP flights count as 1 processing slot
  const isDep = record.type === 'D' || ('side' in record && record.side === 'DEP');
  if (!isDep) return null;

  if (record.status === 'deleted' || record.action === 'deleted') return null;
  if (record.request_status_code && /^(cnl|cancelled|cxl)$/i.test(record.request_status_code.trim())) {
    return null;
  }

  const scheduledDate = record.scheduled_date || record.date;
  const scheduledTime = record.scheduled_time || record.schedule;
  if (!scheduledDate || !scheduledTime) return null;

  const timeClean = scheduledTime.slice(0, 5);
  const stdEpochMs = parseVietnamDateTimeToEpochMs(scheduledDate, timeClean);
  if (stdEpochMs === null || isNaN(stdEpochMs)) return null;

  const slotStartEpochMs = stdEpochMs - params.slotBeforeMinutes * 60_000;
  const slotEndEpochMs = stdEpochMs - params.slotAfterMinutes * 60_000;
  const opsDate = resolveOpsDate(scheduledDate, timeClean, params.opsDayCutoffTime);

  return {
    recordId: record.draft_id,
    airline: record.airline || '',
    flightNumber: record.flight_number || '',
    scheduledDate,
    scheduledTime: timeClean,
    stdDateTimeIso: formatEpochMsToVietnamIso(stdEpochMs),
    stdEpochMs,
    slotStartEpochMs,
    slotEndEpochMs,
    opsDate,
  };
}

export interface ExtractedActiveDepFlightsResult {
  flights: FeasibleStdNormalizedFlight[];
  malformedCount: number;
}

/**
 * Extracts, deduplicates, and validates all active DEP flights from raw planning records.
 * Handles:
 * - draft_id uniqueness
 * - codeshare deduplication: prevents counting both operating and marketing flights of the same departure
 * - flags malformed active DEP flights instead of silently ignoring them
 */
export function extractActiveDepFlightsDetailed(
  records: readonly SeasonalDraftRecord[],
  params: FeasibleStdParams = DEFAULT_FEASIBLE_STD_PARAMS
): ExtractedActiveDepFlightsResult {
  const seenIds = new Set<string>();
  const list: FeasibleStdNormalizedFlight[] = [];
  let malformedCount = 0;

  const knownCodeshareSlots = new Set<string>();
  const canonicalDepartureSlots = new Set<string>();

  for (const r of records) {
    if (!r || !r.draft_id) continue;
    if (seenIds.has(r.draft_id)) continue;
    seenIds.add(r.draft_id);

    const isDep = r.type === 'D' || ('side' in r && r.side === 'DEP');
    if (!isDep) continue;
    if (r.status === 'deleted' || r.action === 'deleted') continue;
    if (r.request_status_code && /^(cnl|cancelled|cxl)$/i.test(r.request_status_code.trim())) {
      continue;
    }

    const scheduledDate = r.scheduled_date || r.date;
    const scheduledTime = r.scheduled_time || r.schedule;
    if (!scheduledDate || !scheduledTime) {
      malformedCount++;
      continue;
    }

    const timeClean = scheduledTime.slice(0, 5);
    const stdEpochMs = parseVietnamDateTimeToEpochMs(scheduledDate, timeClean);
    if (stdEpochMs === null || isNaN(stdEpochMs)) {
      malformedCount++;
      continue;
    }

    const airline = (r.airline || '').trim().toUpperCase();
    const flightNum = (r.flight_number || '').trim().toUpperCase();
    const fullFlight = flightNum.startsWith(airline) ? flightNum : `${airline}${flightNum}`;
    const route = (r.route || '').trim().toUpperCase();
    const aircraft = (r.aircraft || '').trim().toUpperCase();

    // Check codeshare duplicate
    const slotCodeshareKey = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${fullFlight}`;
    const slotCodeNumKey = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${flightNum}`;
    if (knownCodeshareSlots.has(slotCodeshareKey) || knownCodeshareSlots.has(slotCodeNumKey)) {
      continue;
    }

    // Check exact canonical duplicate departure slot
    const canonicalSlot = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${aircraft}`;
    if (route && aircraft && canonicalDepartureSlots.has(canonicalSlot)) {
      if (r.code_shares || ('codeShares' in r && r.codeShares)) {
        continue;
      }
    }

    // Register codeshares listed by this flight
    const rawCs = r.code_shares || ('codeShares' in r && typeof r.codeShares === 'string' ? r.codeShares : null);
    if (rawCs && typeof rawCs === 'string') {
      const parts = rawCs.split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      for (const p of parts) {
        knownCodeshareSlots.add(`${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${p}`);
      }
    }
    if (route && aircraft) {
      canonicalDepartureSlots.add(canonicalSlot);
    }

    const slotStartEpochMs = stdEpochMs - params.slotBeforeMinutes * 60_000;
    const slotEndEpochMs = stdEpochMs - params.slotAfterMinutes * 60_000;
    const opsDate = resolveOpsDate(scheduledDate, timeClean, params.opsDayCutoffTime);

    list.push({
      recordId: r.draft_id,
      airline: r.airline || '',
      flightNumber: r.flight_number || '',
      scheduledDate,
      scheduledTime: timeClean,
      stdDateTimeIso: formatEpochMsToVietnamIso(stdEpochMs),
      stdEpochMs,
      slotStartEpochMs,
      slotEndEpochMs,
      opsDate,
    });
  }

  return { flights: list, malformedCount };
}

export function extractActiveDepFlights(
  records: readonly SeasonalDraftRecord[],
  params: FeasibleStdParams = DEFAULT_FEASIBLE_STD_PARAMS
): FeasibleStdNormalizedFlight[] {
  return extractActiveDepFlightsDetailed(records, params).flights;
}

// ---------------------------------------------------------------------------
// Exact Event Sweep Engine (Half-Open Interval Semantics)
// ---------------------------------------------------------------------------

/**
 * Constructs constant demand segments over time using an exact event sweep.
 *
 * Interval semantics: [start, end)
 * - At time `start`: delta = +1
 * - At time `end`: delta = -1
 * Tie-breaking: at the same timestamp, -1 (end) comes before +1 (start).
 */
export function buildDemandSegments(flights: readonly FeasibleStdNormalizedFlight[]): DemandSegment[] {
  if (flights.length === 0) return [];

  interface SweepEvent {
    time: number;
    delta: number;
  }

  const events: SweepEvent[] = [];
  for (const f of flights) {
    if (f.slotStartEpochMs < f.slotEndEpochMs) {
      events.push({ time: f.slotStartEpochMs, delta: 1 });
      events.push({ time: f.slotEndEpochMs, delta: -1 });
    }
  }

  // Sort: earlier time first. If time is equal, delta -1 comes BEFORE delta +1 (end before start)
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.delta - b.delta; // -1 < 1
  });

  const segments: DemandSegment[] = [];
  let currentDemand = 0;
  let lastTime: number | null = null;

  let i = 0;
  while (i < events.length) {
    const t = events[i].time;

    // Process all events happening at this exact timestamp t
    // Group: first sum all negative deltas (flight endings), then positive deltas (flight starts)
    let netDelta = 0;
    while (i < events.length && events[i].time === t) {
      netDelta += events[i].delta;
      i++;
    }

    if (lastTime !== null && t > lastTime && currentDemand > 0) {
      segments.push({
        start: lastTime,
        end: t,
        demand: currentDemand,
      });
    }

    currentDemand += netDelta;
    if (currentDemand < 0) currentDemand = 0; // Guard against negative demand
    lastTime = t;
  }

  return segments;
}

/**
 * Calculates the exact maximum demand M(X) and earliest peak moment within a candidate window:
 * Window = [windowStartMs, windowEndMs)
 */
export function findMaxDemandInWindow(
  segments: readonly DemandSegment[],
  windowStartMs: number,
  windowEndMs: number
): { maxDemand: number; peakAtMs: number } {
  if (windowStartMs >= windowEndMs || segments.length === 0) {
    return { maxDemand: 0, peakAtMs: windowStartMs };
  }

  let maxDemand = 0;
  let peakAtMs = windowStartMs;

  for (const seg of segments) {
    // Check if segment [seg.start, seg.end) intersects window [windowStartMs, windowEndMs)
    const overlapStart = Math.max(seg.start, windowStartMs);
    const overlapEnd = Math.min(seg.end, windowEndMs);

    if (overlapStart < overlapEnd) {
      if (seg.demand > maxDemand) {
        maxDemand = seg.demand;
        peakAtMs = overlapStart;
      }
    }
  }

  return { maxDemand, peakAtMs };
}

/**
 * Evaluates a single candidate STD timestamp against the demand segments.
 */
export function evaluateCandidateStdAtEpochMs(
  segments: readonly DemandSegment[],
  candidateStdMs: number,
  params: FeasibleStdParams = DEFAULT_FEASIBLE_STD_PARAMS
): FeasibleStdCandidatePoint {
  const windowStartMs = candidateStdMs - params.slotBeforeMinutes * 60_000;
  const windowEndMs = candidateStdMs - params.slotAfterMinutes * 60_000;

  const { maxDemand, peakAtMs } = findMaxDemandInWindow(segments, windowStartMs, windowEndMs);

  const status: FeasibleStdStatus =
    maxDemand < params.threshold ? 'green' : maxDemand === params.threshold ? 'amber' : 'red';
  const remaining = Math.max(0, params.threshold - maxDemand);
  const projectedMax = maxDemand + 1;
  const canAddOne = projectedMax <= params.threshold;

  return {
    candidateStd: formatEpochMsToVietnamIso(candidateStdMs),
    stdLabel: formatEpochMsToVietnamTimeLabel(candidateStdMs),
    windowStart: formatEpochMsToVietnamIso(windowStartMs),
    windowEnd: formatEpochMsToVietnamIso(windowEndMs),
    maxDemand,
    peakAt: formatEpochMsToVietnamIso(peakAtMs),
    status,
    remaining,
    projectedMax,
    canAddOne,
  };
}

// ---------------------------------------------------------------------------
// Day Analysis & Grid Generation
// ---------------------------------------------------------------------------

/**
 * Analyzes the Feasible STD candidate grid for a given operational day.
 *
 * Rules:
 * - Candidates are generated from [min_STD - buffer, max_STD + buffer] with step STEP.
 * - Flights belonging to the operational date define the candidate range.
 * - Cross-day demand: uses ALL flights in the same planning source whose processing
 *   windows overlap the candidate windows (e.g. from day d-1 or d+1).
 * - Empty day: if 0 active DEP flights in this ops date, returns candidates = [] with hasFlights = false.
 */
export function analyzeDayFeasibleStd(
  allSourceFlights: readonly SeasonalDraftRecord[],
  targetOpsDate: string,
  userParams?: Partial<FeasibleStdParams>,
  seasonRange?: { start: string; end: string }
): DayFeasibleStdResult {
  const params: FeasibleStdParams = { ...DEFAULT_FEASIBLE_STD_PARAMS, ...userParams };
  validateFeasibleStdParams(params);

  // 1. Extract all active DEP flights in source with detailed validation & codeshare dedupe
  const { flights: allDepFlights, malformedCount } = extractActiveDepFlightsDetailed(allSourceFlights, params);

  // 2. Filter flights belonging to targetOpsDate
  const targetDayFlights = allDepFlights.filter((f) => f.opsDate === targetOpsDate);

  // Check incomplete condition (e.g. season bounds or malformed active DEP records)
  let isIncomplete = false;
  let incompleteReason: string | undefined;
  if (malformedCount > 0) {
    isIncomplete = true;
    incompleteReason = `Có ${malformedCount} chuyến bay DEP active chứa dữ liệu ngày giờ không hợp lệ`;
  } else if (seasonRange && seasonRange.start && seasonRange.end) {
    if (targetOpsDate < seasonRange.start || targetOpsDate > seasonRange.end) {
      isIncomplete = true;
      incompleteReason = `Ngày vận hành ${targetOpsDate} nằm ngoài phạm vi mùa [${seasonRange.start}, ${seasonRange.end}]`;
    }
  }
  if (targetDayFlights.length === 0) {
    return {
      opsDate: targetOpsDate,
      params,
      candidates: [],
      countedDepFlights: 0,
      overallMaxDemand: 0,
      overallPeakAt: null,
      hasFlights: false,
      isIncomplete,
      incompleteReason,
    };
  }

  // 3. Build global demand segments from ALL flights in the source
  // This guarantees cross-day demand window overlap is fully accounted for.
  const demandSegments = buildDemandSegments(allDepFlights);

  // 4. Compute candidate range: [min_STD - buffer, max_STD + buffer]
  let minStdMs = Infinity;
  let maxStdMs = -Infinity;
  for (const f of targetDayFlights) {
    if (f.stdEpochMs < minStdMs) minStdMs = f.stdEpochMs;
    if (f.stdEpochMs > maxStdMs) maxStdMs = f.stdEpochMs;
  }

  const rangeStartRaw = minStdMs - params.stdRangeBufferMinutes * 60_000;
  const rangeEndRaw = maxStdMs + params.stdRangeBufferMinutes * 60_000;

  const stepMs = params.stepMinutes * 60_000;

  const candidates: FeasibleStdCandidatePoint[] = [];
  let overallMaxDemand = 0;
  let overallPeakAt: string | null = null;

  for (let candMs = rangeStartRaw; candMs <= rangeEndRaw; candMs += stepMs) {
    const point = evaluateCandidateStdAtEpochMs(demandSegments, candMs, params);
    candidates.push(point);

    if (point.maxDemand > overallMaxDemand) {
      overallMaxDemand = point.maxDemand;
      overallPeakAt = point.peakAt;
    }
  }

  return {
    opsDate: targetOpsDate,
    params,
    candidates,
    countedDepFlights: targetDayFlights.length,
    overallMaxDemand,
    overallPeakAt,
    hasFlights: true,
    isIncomplete,
    incompleteReason,
    candidateMinStdLabel: candidates.length > 0 ? candidates[0].stdLabel : undefined,
    candidateMaxStdLabel: candidates.length > 0 ? candidates[candidates.length - 1].stdLabel : undefined,
  };
}

// ---------------------------------------------------------------------------
// Arbitrary Candidate Datetime Evaluation (Simulation Box)
// ---------------------------------------------------------------------------

/**
 * Evaluates feasibility for an arbitrary candidate STD datetime string
 * (e.g. '2026-10-15T09:37:00' or date + time) without rounding to the 5-minute grid.
 */
export function evaluateArbitraryCandidateStd(
  allSourceFlights: readonly SeasonalDraftRecord[],
  candidateStdIso: string,
  userParams?: Partial<FeasibleStdParams>
): FeasibleStdAssessmentResult {
  const params: FeasibleStdParams = { ...DEFAULT_FEASIBLE_STD_PARAMS, ...userParams };
  validateFeasibleStdParams(params);
  if (!candidateStdIso || typeof candidateStdIso !== 'string') {
    throw new Error('candidateStdIso is required');
  }

  // Parse candidate ISO string (formats: 'YYYY-MM-DDTHH:mm:ss' or 'YYYY-MM-DD HH:mm')
  const cleanIso = candidateStdIso.trim().replace(' ', 'T');
  const [datePart, timePart] = cleanIso.split('T');
  if (!datePart || !timePart) {
    throw new Error(`Định dạng ngày giờ không hợp lệ: ${candidateStdIso}`);
  }

  const candEpochMs = parseVietnamDateTimeToEpochMs(datePart, timePart);
  if (candEpochMs === null || isNaN(candEpochMs)) {
    throw new Error(`Không thể phân tích ngày giờ: ${candidateStdIso}`);
  }

  const allDepFlights = extractActiveDepFlights(allSourceFlights, params);
  const demandSegments = buildDemandSegments(allDepFlights);

  const candidate = evaluateCandidateStdAtEpochMs(demandSegments, candEpochMs, params);

  let explanation = '';
  if (candidate.status === 'green') {
    if (candidate.canAddOne) {
      explanation = `Khả thi. Tải tối đa trong cửa sổ là ${candidate.maxDemand}/${params.threshold} slot (đạt lúc ${candidate.peakAt.slice(11, 16)}). Sau khi thêm 1 chuyến, tải dự kiến là ${candidate.projectedMax}/${params.threshold}, vẫn trong ngưỡng tiếp nhận.`;
    } else {
      explanation = `Khả thi ở hiện tại (${candidate.maxDemand}/${params.threshold}), nhưng sau khi thêm chuyến sẽ vượt ngưỡng tiếp nhận.`;
    }
  } else if (candidate.status === 'amber') {
    explanation = `Đã đạt ngưỡng tối đa (${candidate.maxDemand}/${params.threshold} slot lúc ${candidate.peakAt.slice(11, 16)}). Không thể tiếp nhận thêm chuyến bay mới vì tải dự kiến sẽ là ${candidate.projectedMax}/${params.threshold}.`;
  } else {
    explanation = `Vượt ngưỡng tiếp nhận (${candidate.maxDemand}/${params.threshold} slot lúc ${candidate.peakAt.slice(11, 16)}). Không thể tiếp nhận thêm chuyến bay tại khung giờ này.`;
  }

  return { candidate, explanation };
}
