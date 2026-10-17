/**
 * Flight Slot Occupancy Dashboard Engine (Pure TypeScript)
 *
 * Implements 1:1 mathematical and visual data parity with:
 * - SlotReport_Portable/build_report.py
 * - SlotReport_Portable/template.html
 *
 * Rules:
 * - Each active DEP flight occupies slots in [STD - slotBefore, STD - slotAfter) (default [STD-180, STD-50)).
 * - In 'aircraft_code' mode (default): ICAO/IATA code D/E/F widebody aircraft occupy 2 slots; code C/others occupy 1 slot.
 * - In 'uniform' mode: every active DEP flight occupies 1 slot.
 * - Operational day runs 05:00 -> 05:00 next calendar day (Asia/Ho_Chi_Minh, UTC+7).
 * - Demand is computed on a single continuous minute timeline so cross-day windows never get clipped at 05:00.
 * - Aggregation over selected operational days (All Season / Month / Weekday):
 *   - avg[k]   = mean of feas[:, k] across selected days
 *   - max[k]   = max of feas[:, k] across selected days
 *   - pctC[k]  = % of days where feas[i, k] <= threshold - 1
 *   - pctDE[k] = % of days where feas[i, k] <= threshold - 2
 *   - davg[k], dmin[k], dmax[k] = mean/min/max of clock-time 5-min demand dem[:, k]
 *   - dok[k]   = % of days where dem[i, k] <= threshold - 1
 */

import type { SeasonalDraftRecord } from './seasonalPlanningContract.ts';
import {
  parseVietnamDateTimeToEpochMs,
  resolveOpsDate,
  shiftVietnamIsoDate,
} from './feasibleStdAnalysis.ts';

export type SlotWeightMode = 'aircraft_code' | 'uniform';
export type SlotStatusColor = 'green' | 'amber' | 'red';

export interface SlotOccupancyParams {
  slotBefore: number; // default: 180
  slotAfter: number;  // default: 50
  threshold: number;  // default: 13
  opsStart: number;   // default: 300 (05:00)
  step: number;       // default: 5
  okGreen: number;    // default: 85 (%)
  okAmber: number;    // default: 50 (%)
  slotWeightMode: SlotWeightMode; // default: 'aircraft_code'
}

export const DEFAULT_SLOT_OCCUPANCY_PARAMS: SlotOccupancyParams = {
  slotBefore: 180,
  slotAfter: 50,
  threshold: 13,
  opsStart: 300,
  step: 5,
  okGreen: 85,
  okAmber: 50,
  slotWeightMode: 'aircraft_code',
};

export const WEEKDAY_LABELS_VN = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] as const;

export const AIRCRAFT_CODE_BY_TYPE: Readonly<Record<string, 'D' | 'E' | 'F'>> = {
  B752: 'D', B753: 'D', B762: 'D', B763: 'D', B764: 'D', A310: 'D', MD11: 'D',
  '752': 'D', '753': 'D', '762': 'D', '763': 'D', '764': 'D', '310': 'D', '313': 'D', M11: 'D',
  A332: 'E', A333: 'E', A338: 'E', A339: 'E', A342: 'E', A343: 'E', A345: 'E', A346: 'E',
  A359: 'E', A35K: 'E', B772: 'E', B773: 'E', B77L: 'E', B77W: 'E', B778: 'E', B779: 'E',
  B788: 'E', B789: 'E', B78X: 'E', B744: 'E',
  '332': 'E', '333': 'E', '338': 'E', '339': 'E', '342': 'E', '343': 'E', '345': 'E', '346': 'E', '359': 'E', '351': 'E',
  '772': 'E', '773': 'E', '77L': 'E', '77W': 'E', '778': 'E', '779': 'E', '788': 'E', '789': 'E', '781': 'E', '744': 'E',
  A388: 'F', B748: 'F', '388': 'F', '74H': 'F',
};

export function resolveAircraftAerodromeCode(acType: string | null | undefined): '' | 'D' | 'E' | 'F' {
  if (!acType) return '';
  const cleaned = acType.trim().toUpperCase();
  return AIRCRAFT_CODE_BY_TYPE[cleaned] ?? '';
}

export function resolveFlightSlotWeight(
  acType: string | null | undefined,
  mode: SlotWeightMode = 'aircraft_code'
): 1 | 2 {
  if (mode === 'uniform') return 1;
  const code = resolveAircraftAerodromeCode(acType);
  return code === 'D' || code === 'E' || code === 'F' ? 2 : 1;
}

/**
 * Formats minutes from 00:00 (wrapping modulo 1440) as HH:mm, matching template.html `lbl(m)`.
 */
export function formatSlotMinuteLabel(totalMinutes: number): string {
  const m = ((Math.trunc(totalMinutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Formats month key `YYYY * 100 + MM` or `null` into Vietnamese label (`Cả mùa` or `T10/2026`).
 */
export function formatSlotMonthLabel(monthKey: number | null): string {
  if (monthKey == null) return 'Cả mùa';
  const mm = String(monthKey % 100).padStart(2, '0');
  const yyyy = Math.floor(monthKey / 100);
  return `T${mm}/${yyyy}`;
}

export function resolveSlotStatusColor(
  pct: number,
  params: Pick<SlotOccupancyParams, 'okGreen' | 'okAmber'>
): SlotStatusColor {
  if (pct >= params.okGreen) return 'green';
  if (pct >= params.okAmber) return 'amber';
  return 'red';
}

export interface SlotDayFlightTuple {
  name: string;
  std: number; // minutes from 05:00 of the flight's opsDate
  slots: 1 | 2;
  type: string;
  route: string;
}

export interface SlotDayInfo {
  isoDate: string;
  year: number;
  month: number;
  monthKey: number; // year * 100 + month
  weekday: number;  // 0 = T2 .. 6 = CN
}

export interface SlotOccupancyDataset {
  days: string[];
  dayInfo: SlotDayInfo[];
  months: number[];
  numCandidates: number; // 288 for 5-min step
  feas: number[][];      // [dayIdx][candIdx]
  dem: number[][];       // [dayIdx][candIdx]
  flights: SlotDayFlightTuple[][]; // [dayIdx] sorted by STD
  params: SlotOccupancyParams;
  twoSlotAircraftTypes: string[];
  oneSlotAircraftTypes: string[];
}

export interface SlotSelectionStats {
  n: number;
  avg: number[];
  max: number[];
  pctC: number[];
  pctDE: number[];
  davg: number[];
  dmax: number[];
  dmin: number[];
  dok: number[];
}

export interface SlotKpiCardData {
  daysCount: number;
  avgFlightsPerDay: number;
  avgTwoSlotFlightsPerDay: number;
  pct15MinCodeC: number;
  pct15MinCodeDE: number;
  peakClockDemandAvg: number;
  peakClockTimeLabel: string;
  peakClockStatus: SlotStatusColor;
}

export interface SlotAggregatedFlightGroup {
  name: string;
  std: number; // minutes from 05:00 (can be negative or >= 1440 when ext=true)
  slots: 1 | 2;
  type: string;
  route: string;
  n: number;
}

export interface SlotStdTable30MinRow {
  rangeLabel: string;
  status: SlotStatusColor;
  canAcceptC: boolean;
  canAcceptDE: boolean;
  remainingAvg: number;
  pctC: number;
  pctDE: number;
  peakAvg: number;
  peakMax: number;
  overlappingFlightsText: string;
  startCandidateIndex: number;
}

export function binArray(
  values: readonly number[],
  groupSize: number,
  reducer: (...chunk: number[]) => number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += groupSize) {
    out.push(reducer(...values.slice(i, i + groupSize)));
  }
  return out;
}

interface NormalizedDepRecord {
  flightName: string;
  acType: string;
  route: string;
  slots: 1 | 2;
  stdEpochMs: number;
  opsDate: string;
}

function extractDeduplicatedDepRecords(
  records: readonly SeasonalDraftRecord[],
  params: SlotOccupancyParams
): NormalizedDepRecord[] {
  const seenIds = new Set<string>();
  const knownCodeshareSlots = new Set<string>();
  const canonicalDepartureSlots = new Set<string>();
  const list: NormalizedDepRecord[] = [];
  const cutoffStr = formatSlotMinuteLabel(params.opsStart);

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
    if (!scheduledDate || !scheduledTime) continue;

    const timeClean = scheduledTime.slice(0, 5);
    const stdEpochMs = parseVietnamDateTimeToEpochMs(scheduledDate, timeClean);
    if (stdEpochMs === null || Number.isNaN(stdEpochMs)) continue;

    const airline = (r.airline || '').trim().toUpperCase();
    const rawNum = (r.flight_number || '').trim().toUpperCase();
    const fullFlight = rawNum.startsWith(airline) ? rawNum : `${airline}${rawNum}`;
    const route = (r.route || '').trim().toUpperCase();
    const rawAircraft = r.aircraft || ('aircraft_type' in r && typeof r.aircraft_type === 'string' ? r.aircraft_type : '');
    const aircraft = rawAircraft.trim().toUpperCase();

    const slotCodeshareKey = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${fullFlight}`;
    const slotCodeNumKey = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${rawNum}`;
    if (knownCodeshareSlots.has(slotCodeshareKey) || knownCodeshareSlots.has(slotCodeNumKey)) {
      continue;
    }

    const canonicalSlot = `${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${aircraft}`;
    if (route && aircraft && canonicalDepartureSlots.has(canonicalSlot)) {
      if (r.code_shares || ('codeShares' in r && r.codeShares)) {
        continue;
      }
    }

    const rawCs = r.code_shares || ('codeShares' in r && typeof r.codeShares === 'string' ? r.codeShares : null);
    if (rawCs && typeof rawCs === 'string') {
      const parts = rawCs
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      for (const p of parts) {
        knownCodeshareSlots.add(`${scheduledDate}\x1F${timeClean}\x1F${route}\x1F${p}`);
      }
    }
    if (route && aircraft) {
      canonicalDepartureSlots.add(canonicalSlot);
    }

    const opsDate = resolveOpsDate(scheduledDate, timeClean, cutoffStr);
    const slots = resolveFlightSlotWeight(aircraft, params.slotWeightMode);

    list.push({
      flightName: fullFlight || rawNum || airline,
      acType: aircraft,
      route,
      slots,
      stdEpochMs,
      opsDate,
    });
  }

  return list;
}

function buildDateSpine(minDate: string, maxDate: string): string[] {
  if (!minDate || !maxDate || minDate > maxDate) return [];
  const days: string[] = [];
  let cursor = minDate;
  while (cursor <= maxDate) {
    days.push(cursor);
    cursor = shiftVietnamIsoDate(cursor, 1);
  }
  return days;
}

function parseIsoDayInfo(isoDate: string): SlotDayInfo {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const wd = (utc.getUTCDay() + 6) % 7; // 0 = Monday (T2) .. 6 = Sunday (CN)
  return {
    isoDate,
    year: y,
    month: m,
    monthKey: y * 100 + m,
    weekday: wd,
  };
}

/**
 * Builds the complete Slot Occupancy dataset (matching `compute()` + `write_html()` in `build_report.py`).
 */
export function buildSlotOccupancyDataset(
  records: readonly SeasonalDraftRecord[],
  userParams?: Partial<SlotOccupancyParams>,
  dateRange?: { dateFrom?: string | null; dateTo?: string | null }
): SlotOccupancyDataset {
  const params: SlotOccupancyParams = {
    ...DEFAULT_SLOT_OCCUPANCY_PARAMS,
    ...userParams,
  };
  const step = Math.max(1, Math.min(60, Math.trunc(params.step || 5)));
  const slotBefore = Math.max(10, Math.min(360, Math.trunc(params.slotBefore || 180)));
  const slotAfter = Math.max(0, Math.min(slotBefore - 1, Math.trunc(params.slotAfter ?? 50)));
  const threshold = Math.max(1, Math.min(100, Math.trunc(params.threshold || 13)));
  const okGreen = Math.max(1, Math.min(100, Math.trunc(params.okGreen || 85)));
  const okAmber = Math.max(1, Math.min(okGreen, Math.trunc(params.okAmber || 50)));
  const normalizedParams: SlotOccupancyParams = {
    ...params,
    step,
    slotBefore,
    slotAfter,
    threshold,
    okGreen,
    okAmber,
  };

  const numCandidates = Math.floor((24 * 60) / step);
  const allDep = extractDeduplicatedDepRecords(records, normalizedParams);

  const dateFrom = dateRange?.dateFrom?.trim() || null;
  const dateTo = dateRange?.dateTo?.trim() || null;

  // Include 1 neighbor day on each side of [dateFrom, dateTo] in the continuous demand array
  // so boundary windows [STD-before, STD-after) across 05:00 remain exact.
  const paddedFrom = dateFrom ? shiftVietnamIsoDate(dateFrom, -1) : null;
  const paddedTo = dateTo ? shiftVietnamIsoDate(dateTo, 1) : null;

  const relevantDep = allDep.filter((f) => {
    if (paddedFrom && f.opsDate < paddedFrom) return false;
    if (paddedTo && f.opsDate > paddedTo) return false;
    return true;
  });

  const inRangeDep = allDep.filter((f) => {
    if (dateFrom && f.opsDate < dateFrom) return false;
    if (dateTo && f.opsDate > dateTo) return false;
    return true;
  });

  if (inRangeDep.length === 0) {
    return {
      days: [],
      dayInfo: [],
      months: [],
      numCandidates,
      feas: [],
      dem: [],
      flights: [],
      params: normalizedParams,
      twoSlotAircraftTypes: [],
      oneSlotAircraftTypes: [],
    };
  }

  let minVisibleOpsDate = inRangeDep[0].opsDate;
  let maxVisibleOpsDate = inRangeDep[0].opsDate;
  for (const f of inRangeDep) {
    if (f.opsDate < minVisibleOpsDate) minVisibleOpsDate = f.opsDate;
    if (f.opsDate > maxVisibleOpsDate) maxVisibleOpsDate = f.opsDate;
  }

  let minTimelineOpsDate = minVisibleOpsDate;
  for (const f of relevantDep) {
    if (f.opsDate < minTimelineOpsDate) minTimelineOpsDate = f.opsDate;
  }

  const baseDateIso = shiftVietnamIsoDate(minTimelineOpsDate, -1);
  const baseEpochMs = parseVietnamDateTimeToEpochMs(baseDateIso, '00:00')!;

  let maxStdMin = 0;
  const stdMinList = new Int32Array(relevantDep.length);
  for (let i = 0; i < relevantDep.length; i++) {
    const m = Math.round((relevantDep[i].stdEpochMs - baseEpochMs) / 60_000);
    stdMinList[i] = m;
    if (m > maxStdMin) maxStdMin = m;
  }

  const nMin = maxStdMin + 24 * 60;
  const diff = new Int32Array(nMin + 2);
  for (let i = 0; i < relevantDep.length; i++) {
    const startIdx = Math.max(0, stdMinList[i] - slotBefore);
    const endIdx = Math.max(0, stdMinList[i] - slotAfter);
    const w = relevantDep[i].slots;
    if (startIdx <= nMin) diff[startIdx] += w;
    if (endIdx <= nMin) diff[endIdx] -= w;
  }

  const demand = new Int32Array(nMin);
  let running = 0;
  for (let m = 0; m < nMin; m++) {
    running += diff[m];
    demand[m] = running > 0 ? running : 0;
  }

  const days = buildDateSpine(minVisibleOpsDate, maxVisibleOpsDate);
  const dayInfo = days.map(parseIsoDayInfo);
  const months = Array.from(new Set(dayInfo.map((d) => d.monthKey))).sort((a, b) => a - b);

  // Group flights by opsDate for per-day flight list
  const flightsByDay = new Map<string, NormalizedDepRecord[]>();
  const twoSlotSet = new Set<string>();
  const oneSlotSet = new Set<string>();

  for (const f of inRangeDep) {
    if (f.acType) {
      if (f.slots === 2) twoSlotSet.add(f.acType);
      else oneSlotSet.add(f.acType);
    }
    const bucket = flightsByDay.get(f.opsDate);
    if (bucket) bucket.push(f);
    else flightsByDay.set(f.opsDate, [f]);
  }

  const feas: number[][] = new Array(days.length);
  const dem: number[][] = new Array(days.length);
  const flights: SlotDayFlightTuple[][] = new Array(days.length);

  for (let dIdx = 0; dIdx < days.length; dIdx++) {
    const dayIso = days[dIdx];
    const dayEpochMs = parseVietnamDateTimeToEpochMs(dayIso, '00:00')!;
    const day0 = Math.round((dayEpochMs - baseEpochMs) / 60_000) + normalizedParams.opsStart;

    const dayFeas = new Array<number>(numCandidates);
    const dayDem = new Array<number>(numCandidates);

    for (let k = 0; k < numCandidates; k++) {
      const cand = day0 + k * step;
      const wStart = Math.max(0, cand - slotBefore);
      const wEnd = Math.min(nMin, cand - slotAfter);
      let maxInWin = 0;
      for (let t = wStart; t < wEnd; t++) {
        if (demand[t] > maxInWin) maxInWin = demand[t];
      }
      dayFeas[k] = maxInWin;

      const cStart = Math.max(0, cand);
      const cEnd = Math.min(nMin, cand + step);
      let maxInStep = 0;
      for (let t = cStart; t < cEnd; t++) {
        if (demand[t] > maxInStep) maxInStep = demand[t];
      }
      dayDem[k] = maxInStep;
    }

    feas[dIdx] = dayFeas;
    dem[dIdx] = dayDem;

    const rawDayFlights = flightsByDay.get(dayIso) ?? [];
    rawDayFlights.sort((a, b) => a.stdEpochMs - b.stdEpochMs || a.flightName.localeCompare(b.flightName));
    flights[dIdx] = rawDayFlights.map((f) => {
      const stdMin = Math.round((f.stdEpochMs - baseEpochMs) / 60_000);
      return {
        name: f.flightName,
        std: stdMin - day0,
        slots: f.slots,
        type: f.acType,
        route: f.route,
      };
    });
  }

  return {
    days,
    dayInfo,
    months,
    numCandidates,
    feas,
    dem,
    flights,
    params: normalizedParams,
    twoSlotAircraftTypes: Array.from(twoSlotSet).sort(),
    oneSlotAircraftTypes: Array.from(oneSlotSet).sort(),
  };
}

/**
 * Filters day indices matching `selMo` (`YYYY*100 + MM` or `null`) and `selWd` (`0..6` or `null`).
 * Exact match to `idxOf(mo, wd)` in `template.html:129`.
 */
export function filterSlotDayIndices(
  dataset: SlotOccupancyDataset,
  selMo: number | null,
  selWd: number | null
): number[] {
  const out: number[] = [];
  for (let i = 0; i < dataset.dayInfo.length; i++) {
    const info = dataset.dayInfo[i];
    if ((selMo == null || info.monthKey === selMo) && (selWd == null || info.weekday === selWd)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Computes aggregated statistics across the selected day indices `idx`.
 * Exact match to `stats(idx)` in `template.html:130-139`.
 */
export function computeSlotSelectionStats(
  dataset: SlotOccupancyDataset,
  idx: readonly number[]
): SlotSelectionStats {
  const NC = dataset.numCandidates;
  const TH = dataset.params.threshold;
  const n = idx.length;
  if (n === 0) {
    return {
      n: 0,
      avg: new Array<number>(NC).fill(0),
      max: new Array<number>(NC).fill(0),
      pctC: new Array<number>(NC).fill(0),
      pctDE: new Array<number>(NC).fill(0),
      davg: new Array<number>(NC).fill(0),
      dmax: new Array<number>(NC).fill(0),
      dmin: new Array<number>(NC).fill(0),
      dok: new Array<number>(NC).fill(0),
    };
  }

  const s: SlotSelectionStats = {
    n,
    avg: new Array<number>(NC).fill(0),
    max: new Array<number>(NC).fill(0),
    pctC: new Array<number>(NC).fill(0),
    pctDE: new Array<number>(NC).fill(0),
    davg: new Array<number>(NC).fill(0),
    dmax: new Array<number>(NC).fill(0),
    dmin: new Array<number>(NC).fill(1e9),
    dok: new Array<number>(NC).fill(0),
  };

  for (const i of idx) {
    const f = dataset.feas[i];
    const m = dataset.dem[i];
    for (let k = 0; k < NC; k++) {
      s.avg[k] += f[k];
      if (f[k] > s.max[k]) s.max[k] = f[k];
      if (f[k] <= TH - 1) s.pctC[k] += 1;
      if (f[k] <= TH - 2) s.pctDE[k] += 1;

      s.davg[k] += m[k];
      if (m[k] > s.dmax[k]) s.dmax[k] = m[k];
      if (m[k] < s.dmin[k]) s.dmin[k] = m[k];
      if (m[k] <= TH - 1) s.dok[k] += 1;
    }
  }

  for (let k = 0; k < NC; k++) {
    s.avg[k] /= n;
    s.davg[k] /= n;
    s.pctC[k] = (s.pctC[k] * 100) / n;
    s.pctDE[k] = (s.pctDE[k] * 100) / n;
    s.dok[k] = (s.dok[k] * 100) / n;
  }

  return s;
}

/**
 * Computes the 6 KPI cards matching `cards(idx, s)` in `template.html:158-167`.
 */
export function computeSlotKpiCards(
  dataset: SlotOccupancyDataset,
  idx: readonly number[],
  stats: SlotSelectionStats
): SlotKpiCardData {
  if (idx.length === 0) {
    return {
      daysCount: 0,
      avgFlightsPerDay: 0,
      avgTwoSlotFlightsPerDay: 0,
      pct15MinCodeC: 0,
      pct15MinCodeDE: 0,
      peakClockDemandAvg: 0,
      peakClockTimeLabel: '05:00',
      peakClockStatus: 'green',
    };
  }

  const P = dataset.params;
  let nF = 0;
  let n2 = 0;
  for (const i of idx) {
    const dayFlights = dataset.flights[i];
    nF += dayFlights.length;
    for (const f of dayFlights) {
      if (f.slots === 2) n2 += 1;
    }
  }

  let pk = 0;
  stats.davg.forEach((v, k) => {
    if (v > stats.davg[pk]) pk = k;
  });

  const group15Count = Math.max(1, Math.round(15 / P.step));
  const b15 = binArray(stats.pctC, group15Count, Math.min);
  const b15de = binArray(stats.pctDE, group15Count, Math.min);
  const okC = b15.length > 0 ? b15.filter((p) => p >= P.okGreen).length / b15.length : 0;
  const okDE = b15de.length > 0 ? b15de.filter((p) => p >= P.okGreen).length / b15de.length : 0;

  const peakRounded = Math.round(stats.davg[pk]);
  const peakClockStatus: SlotStatusColor =
    peakRounded > P.threshold ? 'red' : peakRounded === P.threshold ? 'amber' : 'green';

  return {
    daysCount: idx.length,
    avgFlightsPerDay: Math.round(nF / idx.length),
    avgTwoSlotFlightsPerDay: Math.round(n2 / idx.length),
    pct15MinCodeC: Math.round(okC * 100),
    pct15MinCodeDE: Math.round(okDE * 100),
    peakClockDemandAvg: peakRounded,
    peakClockTimeLabel: formatSlotMinuteLabel(P.opsStart + pk * P.step),
    peakClockStatus,
  };
}

/**
 * Groups flights across selected days `idx`.
 * Matches `groups(idx, ext)` in `template.html:212-223`:
 * - `ext = false` (used by Gantt chart `c3`): only flights belonging to `idx`.
 * - `ext = true` (used by 30-min table `tb`): also includes `i - 1` spillover flights (`std > 1440 - (slotBefore - slotAfter)`)
 *   and `i + 1` spillover flights (`std < slotBefore`).
 */
export function buildSlotFlightGroups(
  dataset: SlotOccupancyDataset,
  idx: readonly number[],
  ext = false
): SlotAggregatedFlightGroup[] {
  const P = dataset.params;
  const g = new Map<string, SlotAggregatedFlightGroup>();
  const add = (name: string, std: number, slots: 1 | 2, type: string, route: string) => {
    const key = `${name}|${std}|${slots}|${type}`;
    const existing = g.get(key);
    if (existing) {
      existing.n += 1;
    } else {
      g.set(key, { name, std, slots, type, route, n: 1 });
    }
  };

  const win = P.slotBefore - P.slotAfter;
  for (const i of idx) {
    for (const f of dataset.flights[i]) {
      add(f.name, f.std, f.slots, f.type, f.route);
    }
    if (!ext) continue;
    if (i > 0) {
      for (const f of dataset.flights[i - 1]) {
        if (f.std > 1440 - win) {
          add(f.name, f.std - 1440, f.slots, f.type, f.route);
        }
      }
    }
    if (i < dataset.flights.length - 1) {
      for (const f of dataset.flights[i + 1]) {
        if (f.std < P.slotBefore) {
          add(f.name, f.std + 1440, f.slots, f.type, f.route);
        }
      }
    }
  }

  return Array.from(g.values()).sort((a, b) => a.std - b.std || a.name.localeCompare(b.name));
}

/**
 * Builds the 30-minute STD summary table rows matching `table(idx, s)` in `template.html:243-259`.
 */
export function buildSlotStdTable30Min(
  dataset: SlotOccupancyDataset,
  idx: readonly number[],
  stats: SlotSelectionStats
): SlotStdTable30MinRow[] {
  if (idx.length === 0) return [];
  const P = dataset.params;
  const K = Math.max(1, Math.round(30 / P.step));
  const fl = buildSlotFlightGroups(dataset, idx, true);
  const n = idx.length;

  const fA = binArray(stats.avg, K, Math.max);
  const fM = binArray(stats.max, K, Math.max);
  const pC = binArray(stats.pctC, K, Math.min);
  const pD = binArray(stats.pctDE, K, Math.min);

  const rows: SlotStdTable30MinRow[] = [];
  const numRows = Math.floor(dataset.numCandidates / K);

  for (let j = 0; j < numRows; j++) {
    const t = j * K * P.step;
    const tEnd = t + (K - 1) * P.step;
    const sc = resolveSlotStatusColor(pC[j], P);
    const w0 = t - P.slotBefore;
    const w1 = tEnd - P.slotAfter;

    const act = fl
      .filter((f) => f.std - P.slotBefore < w1 && f.std - P.slotAfter > w0)
      .map(
        (f) =>
          `${f.name} ${formatSlotMinuteLabel(P.opsStart + f.std)}${f.slots === 2 ? ' ×2' : ''} (${f.n}/${n})`
      );

    rows.push({
      rangeLabel: `${formatSlotMinuteLabel(P.opsStart + t)} – ${formatSlotMinuteLabel(P.opsStart + tEnd)}`,
      status: sc,
      canAcceptC: pC[j] >= P.okGreen,
      canAcceptDE: pD[j] >= P.okGreen,
      remainingAvg: Math.max(0, P.threshold - Math.round(fA[j])),
      pctC: Math.round(pC[j]),
      pctDE: Math.round(pD[j]),
      peakAvg: Math.round(fA[j]),
      peakMax: fM[j],
      overlappingFlightsText: act.join(', '),
      startCandidateIndex: j * K,
    });
  }

  return rows;
}

/**
 * Computes the Month x Weekday matrix of % 15-minute STD frames accepting Code C.
 * Matches `MX` in `template.html:261-263`.
 */
export function buildSlotMonthWeekdayMatrix(
  dataset: SlotOccupancyDataset
): Map<string, number> {
  const mx = new Map<string, number>();
  const P = dataset.params;
  const group15Count = Math.max(1, Math.round(15 / P.step));
  const monthOptions: Array<number | null> = [null, ...dataset.months];
  const wdOptions: Array<number | null> = [null, 0, 1, 2, 3, 4, 5, 6];

  for (const mo of monthOptions) {
    for (const wd of wdOptions) {
      const idx = filterSlotDayIndices(dataset, mo, wd);
      if (idx.length === 0) continue;
      const st = computeSlotSelectionStats(dataset, idx);
      const b = binArray(st.pctC, group15Count, Math.min);
      if (b.length === 0) continue;
      const ratio = b.filter((p) => p >= P.okGreen).length / b.length;
      mx.set(`${mo}|${wd}`, ratio);
    }
  }

  return mx;
}
