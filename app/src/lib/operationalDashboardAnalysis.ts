import { getOperationalDate } from './iataSeason.ts';
import type { DashboardAlertSettings, FlightRecord } from './types.ts';

export type DashboardTimeBasis = 'local' | 'utc';
export type OperationalDashboardFlightType = 'A' | 'D';
export type OperationalDashboardTypeFilter = 'all' | OperationalDashboardFlightType;
export type OperationalDashboardBucketSize = 30 | 60;
export type OperationalDashboardAlertSeverity = 'critical' | 'warning' | 'info';
export type OperationalDashboardAlertKind =
  | 'arrivalBucketFlights'
  | 'departureBucketFlights'
  | 'adGapFlights'
  | 'ctgAbsPct'
  | 'paxCoverageMinPct';

export type OperationalDashboardRecord = Pick<FlightRecord, 'id' | 'type' | 'date' | 'schedule' | 'pax'> &
  Partial<Pick<
    FlightRecord,
    'scheduledDate' | 'scheduledTime' | 'operationalDate' | 'airline' | 'route' | 'aircraft' | 'flightNumber' | 'status' | 'action'
  >>;

export interface OperationalTimelineBucket {
  index: number;
  label: string;
  localLabel: string;
  utcLabel: string;
  startMinutes: number;
  endMinutes: number;
  operationalOffsetMinutes: number;
  flights: number;
  pax: number;
  baselineFlights: number;
  baselinePax: number;
  baselineSampleSize: number;
  deltaFlights: number;
  deltaPax: number;
  ctgPct: number | null;
  records: OperationalDashboardRecord[];
}

export interface OperationalTimeline {
  operationalDate: string;
  type: OperationalDashboardFlightType;
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
  buckets: OperationalTimelineBucket[];
  totals: {
    flights: number;
    pax: number;
    baselineFlights: number;
    baselinePax: number;
  };
  peakBucket: OperationalTimelineBucket | null;
}

export interface OperationalPaxCoverage {
  totalFlights: number;
  available: number;
  missingAfterOneDay: number;
  plannedZero: number;
  coveragePct: number;
}

export interface OperationalDashboardAlert {
  id: string;
  kind: OperationalDashboardAlertKind;
  severity: OperationalDashboardAlertSeverity;
  message: string;
  value: number;
  threshold: number;
  operationalDate?: string;
  bucketLabel?: string;
  type?: OperationalDashboardFlightType;
}

export interface OperationalDashboardResult {
  operationalDate: string;
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
  arrivals: OperationalTimeline;
  departures: OperationalTimeline;
  kpis: {
    arrivalFlights: number;
    departureFlights: number;
    totalFlights: number;
    totalPax: number;
    adGapFlights: number;
    peakArrivalBucket: OperationalTimelineBucket | null;
    peakDepartureBucket: OperationalTimelineBucket | null;
  };
  paxCoverage: OperationalPaxCoverage;
  alerts: OperationalDashboardAlert[];
}

export interface OperationalPeakDayHeatmapCell {
  operationalDate: string;
  month: string;
  weekday: number;
  arrivals: number;
  departures: number;
  totalFlights: number;
  pax: number;
  paxMissingAfterOneDay: number;
  alerts: OperationalDashboardAlertKind[];
}

export interface OperationalPeakHourHeatmapCell {
  operationalDate: string;
  bucketIndex: number;
  bucketLabel: string;
  arrivals: number;
  departures: number;
  totalFlights: number;
  pax: number;
  adGapFlights: number;
}

export interface OperationalPeakHourHeatmap {
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
  dates: string[];
  buckets: Array<{ index: number; label: string }>;
  cells: OperationalPeakHourHeatmapCell[];
}

const OPERATIONAL_DAY_START_MINUTES = 5 * 60;
const LOCAL_UTC_OFFSET_MINUTES = 7 * 60;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseScheduleMinutes(schedule: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutes(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function shiftMinutesForBasis(minutes: number, timeBasis: DashboardTimeBasis): number {
  return timeBasis === 'utc'
    ? (minutes - LOCAL_UTC_OFFSET_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY
    : minutes;
}

function addIsoDays(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function weekday(date: string): number | null {
  return parseIsoDate(date)?.getUTCDay() ?? null;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function isActiveRecord(record: OperationalDashboardRecord): boolean {
  return record.status !== 'deleted' && record.action !== 'deleted';
}

function recordOperationalDate(record: OperationalDashboardRecord): string {
  if (record.operationalDate) return record.operationalDate;
  const sourceDate = record.scheduledDate ?? record.date;
  const sourceTime = record.scheduledTime ?? record.schedule;
  return getOperationalDate(sourceDate, sourceTime);
}

function recordScheduleMinutes(record: OperationalDashboardRecord): number | null {
  return parseScheduleMinutes(record.scheduledTime ?? record.schedule);
}

function recordPax(record: OperationalDashboardRecord): number {
  return Number.isFinite(record.pax) ? Number(record.pax) : 0;
}

function bucketCount(bucketSizeMinutes: OperationalDashboardBucketSize): number {
  return MINUTES_PER_DAY / bucketSizeMinutes;
}

function bucketIndexForRecord(record: OperationalDashboardRecord, bucketSizeMinutes: OperationalDashboardBucketSize): number | null {
  const minutes = recordScheduleMinutes(record);
  if (minutes == null) return null;
  const operationalOffset = (minutes - OPERATIONAL_DAY_START_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return Math.floor(operationalOffset / bucketSizeMinutes);
}

function bucketStartMinutes(index: number, bucketSizeMinutes: OperationalDashboardBucketSize): number {
  return (OPERATIONAL_DAY_START_MINUTES + index * bucketSizeMinutes) % MINUTES_PER_DAY;
}

function makeEmptyBucket(
  index: number,
  bucketSizeMinutes: OperationalDashboardBucketSize,
  timeBasis: DashboardTimeBasis
): OperationalTimelineBucket {
  const startMinutes = bucketStartMinutes(index, bucketSizeMinutes);
  const endMinutes = (startMinutes + bucketSizeMinutes) % MINUTES_PER_DAY;
  const localLabel = formatMinutes(startMinutes);
  const utcLabel = formatMinutes(shiftMinutesForBasis(startMinutes, 'utc'));
  return {
    index,
    label: timeBasis === 'utc' ? utcLabel : localLabel,
    localLabel,
    utcLabel,
    startMinutes,
    endMinutes,
    operationalOffsetMinutes: index * bucketSizeMinutes,
    flights: 0,
    pax: 0,
    baselineFlights: 0,
    baselinePax: 0,
    baselineSampleSize: 0,
    deltaFlights: 0,
    deltaPax: 0,
    ctgPct: null,
    records: [],
  };
}

function matchingRecords(
  records: OperationalDashboardRecord[],
  operationalDate: string,
  type?: OperationalDashboardFlightType
): OperationalDashboardRecord[] {
  return records.filter((record) => (
    isActiveRecord(record) &&
    recordOperationalDate(record) === operationalDate &&
    (type == null || record.type === type)
  ));
}

function sameWeekdayBaselineDates(
  records: OperationalDashboardRecord[],
  operationalDate: string,
  type: OperationalDashboardFlightType
): string[] {
  const selectedWeekday = weekday(operationalDate);
  if (selectedWeekday == null) return [];
  const selectedMonth = monthKey(operationalDate);
  return Array.from(new Set(
    records
      .filter((record) => isActiveRecord(record) && record.type === type)
      .map((record) => recordOperationalDate(record))
      .filter((date) => date !== operationalDate && monthKey(date) === selectedMonth && weekday(date) === selectedWeekday)
  )).sort();
}

function scheduledLocalTimestamp(record: OperationalDashboardRecord): number | null {
  const date = record.scheduledDate ?? record.date;
  const time = record.scheduledTime ?? record.schedule;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseScheduleMinutes(time) == null) return null;
  const timestamp = Date.parse(`${date}T${time}:00+07:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function computePaxCoverage(records: OperationalDashboardRecord[], nowLocal: Date = new Date()): OperationalPaxCoverage {
  let available = 0;
  let missingAfterOneDay = 0;
  let plannedZero = 0;

  for (const record of records.filter(isActiveRecord)) {
    const pax = Number(record.pax ?? 0);
    if (Number.isFinite(pax) && pax > 0) {
      available += 1;
      continue;
    }
    const scheduledTimestamp = scheduledLocalTimestamp(record);
    if (scheduledTimestamp != null && scheduledTimestamp + MS_PER_DAY < nowLocal.getTime()) {
      missingAfterOneDay += 1;
    } else {
      plannedZero += 1;
    }
  }

  const denominator = available + missingAfterOneDay;
  return {
    totalFlights: records.filter(isActiveRecord).length,
    available,
    missingAfterOneDay,
    plannedZero,
    coveragePct: denominator > 0 ? available / denominator : 1,
  };
}

export function buildOperationalTimeline(input: {
  records: OperationalDashboardRecord[];
  operationalDate: string;
  type: OperationalDashboardFlightType;
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
}): OperationalTimeline {
  const buckets = Array.from({ length: bucketCount(input.bucketSizeMinutes) }, (_, index) =>
    makeEmptyBucket(index, input.bucketSizeMinutes, input.timeBasis)
  );

  for (const record of matchingRecords(input.records, input.operationalDate, input.type)) {
    const index = bucketIndexForRecord(record, input.bucketSizeMinutes);
    if (index == null) continue;
    const bucket = buckets[index];
    bucket.flights += 1;
    bucket.pax += recordPax(record);
    bucket.records.push(record);
  }

  const baselineDates = sameWeekdayBaselineDates(input.records, input.operationalDate, input.type);
  const baselineCounts = buckets.map(() => ({ flights: 0, pax: 0 }));
  for (const date of baselineDates) {
    const perDateCounts = buckets.map(() => ({ flights: 0, pax: 0 }));
    for (const record of matchingRecords(input.records, date, input.type)) {
      const index = bucketIndexForRecord(record, input.bucketSizeMinutes);
      if (index == null) continue;
      perDateCounts[index].flights += 1;
      perDateCounts[index].pax += recordPax(record);
    }
    perDateCounts.forEach((count, index) => {
      baselineCounts[index].flights += count.flights;
      baselineCounts[index].pax += count.pax;
    });
  }

  buckets.forEach((bucket, index) => {
    const divisor = baselineDates.length || 0;
    bucket.baselineSampleSize = baselineDates.length;
    bucket.baselineFlights = divisor > 0 ? baselineCounts[index].flights / divisor : 0;
    bucket.baselinePax = divisor > 0 ? baselineCounts[index].pax / divisor : 0;
    bucket.deltaFlights = bucket.flights - bucket.baselineFlights;
    bucket.deltaPax = bucket.pax - bucket.baselinePax;
    bucket.ctgPct = bucket.baselineFlights > 0 ? bucket.deltaFlights / bucket.baselineFlights : null;
  });

  const totals = buckets.reduce(
    (acc, bucket) => ({
      flights: acc.flights + bucket.flights,
      pax: acc.pax + bucket.pax,
      baselineFlights: acc.baselineFlights + bucket.baselineFlights,
      baselinePax: acc.baselinePax + bucket.baselinePax,
    }),
    { flights: 0, pax: 0, baselineFlights: 0, baselinePax: 0 }
  );
  const peakBucket = buckets.reduce<OperationalTimelineBucket | null>((peak, bucket) => {
    if (bucket.flights <= 0) return peak;
    if (!peak || bucket.flights > peak.flights) return bucket;
    return peak;
  }, null);

  return {
    operationalDate: input.operationalDate,
    type: input.type,
    bucketSizeMinutes: input.bucketSizeMinutes,
    timeBasis: input.timeBasis,
    buckets,
    totals,
    peakBucket,
  };
}

function alertSeverityOrder(severity: OperationalDashboardAlertSeverity): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function pushThresholdAlert(
  alerts: OperationalDashboardAlert[],
  threshold: number | null,
  alert: Omit<OperationalDashboardAlert, 'threshold'>
): void {
  if (threshold == null || alert.value < threshold) return;
  alerts.push({ ...alert, threshold });
}

function strongestCtgBucket(timeline: OperationalTimeline): OperationalTimelineBucket | null {
  return timeline.buckets.reduce<OperationalTimelineBucket | null>((strongest, bucket) => {
    if (bucket.ctgPct == null) return strongest;
    if (!strongest || Math.abs(bucket.ctgPct) > Math.abs(strongest.ctgPct ?? 0)) return bucket;
    return strongest;
  }, null);
}

function buildAlerts(input: {
  operationalDate: string;
  settings: DashboardAlertSettings;
  arrivals: OperationalTimeline;
  departures: OperationalTimeline;
  paxCoverage: OperationalPaxCoverage;
  adGapFlights: number;
}): OperationalDashboardAlert[] {
  const alerts: OperationalDashboardAlert[] = [];
  const arrivalPeak = input.arrivals.peakBucket;
  if (arrivalPeak) {
    pushThresholdAlert(alerts, input.settings.arrivalBucketFlights, {
      id: `arrivalBucketFlights:${input.operationalDate}:${arrivalPeak.label}`,
      kind: 'arrivalBucketFlights',
      severity: 'warning',
      message: `ARR bucket ${arrivalPeak.label} has ${arrivalPeak.flights} flights.`,
      value: arrivalPeak.flights,
      operationalDate: input.operationalDate,
      bucketLabel: arrivalPeak.label,
      type: 'A',
    });
  }

  const departurePeak = input.departures.peakBucket;
  if (departurePeak) {
    pushThresholdAlert(alerts, input.settings.departureBucketFlights, {
      id: `departureBucketFlights:${input.operationalDate}:${departurePeak.label}`,
      kind: 'departureBucketFlights',
      severity: 'warning',
      message: `DEP bucket ${departurePeak.label} has ${departurePeak.flights} flights.`,
      value: departurePeak.flights,
      operationalDate: input.operationalDate,
      bucketLabel: departurePeak.label,
      type: 'D',
    });
  }

  pushThresholdAlert(alerts, input.settings.adGapFlights, {
    id: `adGapFlights:${input.operationalDate}`,
    kind: 'adGapFlights',
    severity: 'warning',
    message: `A-D gap is ${input.adGapFlights} flights.`,
    value: input.adGapFlights,
    operationalDate: input.operationalDate,
  });

  const strongestCtg = [strongestCtgBucket(input.arrivals), strongestCtgBucket(input.departures)]
    .filter((bucket): bucket is OperationalTimelineBucket => bucket != null)
    .sort((left, right) => Math.abs(right.ctgPct ?? 0) - Math.abs(left.ctgPct ?? 0))[0] ?? null;
  if (strongestCtg?.ctgPct != null) {
    pushThresholdAlert(alerts, input.settings.ctgAbsPct, {
      id: `ctgAbsPct:${input.operationalDate}:${strongestCtg.label}`,
      kind: 'ctgAbsPct',
      severity: 'info',
      message: `Bucket ${strongestCtg.label} CTG is ${strongestCtg.ctgPct}.`,
      value: Math.abs(strongestCtg.ctgPct),
      operationalDate: input.operationalDate,
      bucketLabel: strongestCtg.label,
    });
  }

  if (
    input.settings.paxCoverageMinPct != null &&
    input.paxCoverage.coveragePct < input.settings.paxCoverageMinPct
  ) {
    alerts.push({
      id: `paxCoverageMinPct:${input.operationalDate}`,
      kind: 'paxCoverageMinPct',
      severity: 'critical',
      message: `Pax coverage is ${input.paxCoverage.coveragePct}.`,
      value: input.paxCoverage.coveragePct,
      threshold: input.settings.paxCoverageMinPct,
      operationalDate: input.operationalDate,
    });
  }

  return alerts.sort((left, right) =>
    alertSeverityOrder(left.severity) - alertSeverityOrder(right.severity) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

export function buildOperationalDashboard(input: {
  records: OperationalDashboardRecord[];
  operationalDate: string;
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
  settings: DashboardAlertSettings;
  nowLocal?: Date;
}): OperationalDashboardResult {
  const arrivals = buildOperationalTimeline({
    records: input.records,
    operationalDate: input.operationalDate,
    type: 'A',
    bucketSizeMinutes: input.bucketSizeMinutes,
    timeBasis: input.timeBasis,
  });
  const departures = buildOperationalTimeline({
    records: input.records,
    operationalDate: input.operationalDate,
    type: 'D',
    bucketSizeMinutes: input.bucketSizeMinutes,
    timeBasis: input.timeBasis,
  });
  const selectedRecords = matchingRecords(input.records, input.operationalDate);
  const paxCoverage = computePaxCoverage(selectedRecords, input.nowLocal ?? new Date());
  const adGapFlights = Math.abs(arrivals.totals.flights - departures.totals.flights);
  const alerts = buildAlerts({
    operationalDate: input.operationalDate,
    settings: input.settings,
    arrivals,
    departures,
    paxCoverage,
    adGapFlights,
  });

  return {
    operationalDate: input.operationalDate,
    bucketSizeMinutes: input.bucketSizeMinutes,
    timeBasis: input.timeBasis,
    arrivals,
    departures,
    kpis: {
      arrivalFlights: arrivals.totals.flights,
      departureFlights: departures.totals.flights,
      totalFlights: arrivals.totals.flights + departures.totals.flights,
      totalPax: arrivals.totals.pax + departures.totals.pax,
      adGapFlights,
      peakArrivalBucket: arrivals.peakBucket,
      peakDepartureBucket: departures.peakBucket,
    },
    paxCoverage,
    alerts,
  };
}

function rangeFilteredOperationalDates(records: OperationalDashboardRecord[], dateFrom?: string, dateTo?: string): string[] {
  return Array.from(new Set(
    records
      .filter(isActiveRecord)
      .map((record) => recordOperationalDate(record))
      .filter((date) => (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo))
  )).sort();
}

export function buildPeakDayHeatmap(input: {
  records: OperationalDashboardRecord[];
  dateFrom?: string;
  dateTo?: string;
  settings?: DashboardAlertSettings;
  nowLocal?: Date;
}): OperationalPeakDayHeatmapCell[] {
  return rangeFilteredOperationalDates(input.records, input.dateFrom, input.dateTo).map((operationalDate) => {
    const recordsForDate = matchingRecords(input.records, operationalDate);
    const arrivals = recordsForDate.filter((record) => record.type === 'A');
    const departures = recordsForDate.filter((record) => record.type === 'D');
    const paxCoverage = computePaxCoverage(recordsForDate, input.nowLocal ?? new Date());
    const alertKinds: OperationalDashboardAlertKind[] = [];
    const adGapFlights = Math.abs(arrivals.length - departures.length);
    if (input.settings?.adGapFlights != null && adGapFlights >= input.settings.adGapFlights) alertKinds.push('adGapFlights');
    if (input.settings?.paxCoverageMinPct != null && paxCoverage.coveragePct < input.settings.paxCoverageMinPct) alertKinds.push('paxCoverageMinPct');
    return {
      operationalDate,
      month: monthKey(operationalDate),
      weekday: weekday(operationalDate) ?? 0,
      arrivals: arrivals.length,
      departures: departures.length,
      totalFlights: recordsForDate.length,
      pax: recordsForDate.reduce((sum, record) => sum + recordPax(record), 0),
      paxMissingAfterOneDay: paxCoverage.missingAfterOneDay,
      alerts: alertKinds,
    };
  });
}

export function buildPeakHourHeatmap(input: {
  records: OperationalDashboardRecord[];
  bucketSizeMinutes: OperationalDashboardBucketSize;
  timeBasis: DashboardTimeBasis;
  typeFilter?: OperationalDashboardTypeFilter;
  dateFrom?: string;
  dateTo?: string;
}): OperationalPeakHourHeatmap {
  const dates = rangeFilteredOperationalDates(input.records, input.dateFrom, input.dateTo);
  const buckets = Array.from({ length: bucketCount(input.bucketSizeMinutes) }, (_, index) => {
    const startMinutes = bucketStartMinutes(index, input.bucketSizeMinutes);
    return {
      index,
      label: formatMinutes(shiftMinutesForBasis(startMinutes, input.timeBasis)),
    };
  });
  const cells: OperationalPeakHourHeatmapCell[] = [];

  for (const operationalDate of dates) {
    const counts = buckets.map((bucket) => ({
      operationalDate,
      bucketIndex: bucket.index,
      bucketLabel: bucket.label,
      arrivals: 0,
      departures: 0,
      totalFlights: 0,
      pax: 0,
      adGapFlights: 0,
    }));
    for (const record of matchingRecords(input.records, operationalDate)) {
      if (input.typeFilter && input.typeFilter !== 'all' && record.type !== input.typeFilter) continue;
      const index = bucketIndexForRecord(record, input.bucketSizeMinutes);
      if (index == null) continue;
      const cell = counts[index];
      if (record.type === 'A') cell.arrivals += 1;
      if (record.type === 'D') cell.departures += 1;
      cell.totalFlights += 1;
      cell.pax += recordPax(record);
      cell.adGapFlights = Math.abs(cell.arrivals - cell.departures);
    }
    cells.push(...counts);
  }

  return {
    bucketSizeMinutes: input.bucketSizeMinutes,
    timeBasis: input.timeBasis,
    dates,
    buckets,
    cells,
  };
}

export { addIsoDays as addOperationalDashboardIsoDays };
