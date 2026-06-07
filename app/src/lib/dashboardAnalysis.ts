import type { FlightModification, FlightRecord, RouteCountryMapping } from './types';
import { resolveCountryForRoute } from './routeCountry';

export type DashboardComparisonMode = 'mom' | 'wow' | 'yoy';
export type DashboardComparisonGranularity = 'month' | 'year';
export type DashboardMetric = 'flights' | 'pax';
export type DashboardTypeFilter = 'all' | 'A' | 'D';
export type DashboardTimeBasis = 'local' | 'utc';
export type DashboardDimension = 'airline' | 'route' | 'country' | 'aircraft' | 'type' | 'dayOfWeek' | 'hourBucket' | 'flightNumber';
export type DashboardComparisonStatus = 'ready' | 'empty' | 'partial';

export interface DashboardComparisonInput {
  records: FlightRecord[];
  routeCountries?: RouteCountryMapping[];
  mode: DashboardComparisonMode;
  granularity?: DashboardComparisonGranularity;
  metric: DashboardMetric;
  currentPeriod: string;
  previousPeriod: string;
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  dimension: DashboardDimension;
}

export interface DashboardPeriodSummary {
  key: string;
  label: string;
  total: number;
  recordCount: number;
}

export interface DashboardDriverContribution {
  key: string;
  label: string;
  currentValue: number;
  previousValue: number;
  delta: number;
  deltaPct: number | null;
  ctgPct: number | null;
  currentShare: number;
  previousShare: number;
  shareShift: number;
}

export interface DashboardComparisonResult {
  mode: DashboardComparisonMode;
  granularity: DashboardComparisonGranularity;
  metric: DashboardMetric;
  dimension: DashboardDimension;
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  status: DashboardComparisonStatus;
  current: DashboardPeriodSummary;
  previous: DashboardPeriodSummary;
  delta: number;
  deltaPct: number | null;
  periodLabels: {
    current: string;
    previous: string;
  };
  drivers: DashboardDriverContribution[];
}

export interface DashboardOverviewInput {
  records: FlightRecord[];
  routeCountries?: RouteCountryMapping[];
  typeFilter: DashboardTypeFilter;
  timeBasis: DashboardTimeBasis;
  monthFrom?: string;
  monthTo?: string;
  peakHourMonth?: string;
  airline?: string;
  country?: string;
  route?: string;
}

export interface DashboardOverviewRankRow {
  key: string;
  label: string;
  flights: number;
  pax: number;
  share: number;
}

export interface DashboardOverviewMonthRow {
  key: string;
  label: string;
  arrivals: number;
  departures: number;
  total: number;
  pax: number;
}

export interface DashboardOverviewDailyRow {
  date: string;
  month: string;
  day: string;
  label: string;
  weekday: string;
  arrivals: number;
  departures: number;
  total: number;
  pax: number;
}

export interface DashboardOverviewCountryRouteRow {
  country: string;
  route: string;
  flights: number;
  pax: number;
  share: number;
}

export interface DashboardOverviewHeatmapCell {
  month: string;
  monthLabel: string;
  weekday: string;
  flights: number;
  operatingDays: number;
  avgFlightsPerDay: number;
}

export interface DashboardOverviewPeakHourRow {
  bucket: string;
  flights: number;
  arrivals: number;
  departures: number;
  operatingDays: number;
  avgFlightsPerDay: number;
  avgArrivalsPerDay: number;
  avgDeparturesPerDay: number;
}

export interface DashboardPeakHourAxisTick {
  index: number;
  label: string;
}

export interface DashboardOverviewResult {
  records: FlightRecord[];
  airlineOptions: string[];
  countryOptions: string[];
  routeOptions: string[];
  kpis: {
    totalFlights: number;
    totalPax: number;
    avgFlightsPerDay: number;
    peakMonth: DashboardOverviewRankRow;
    topAirline: DashboardOverviewRankRow;
    topRoute: DashboardOverviewRankRow;
  };
  monthlyTrend: DashboardOverviewMonthRow[];
  dailyTrend: DashboardOverviewDailyRow[];
  airlineRanking: DashboardOverviewRankRow[];
  countryRouteContribution: DashboardOverviewCountryRouteRow[];
  weekdayHeatmap: DashboardOverviewHeatmapCell[];
  aircraftMix: DashboardOverviewRankRow[];
  peakHourAverage: DashboardOverviewPeakHourRow[];
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTES_PER_DAY = 24 * 60;
const LOCAL_UTC_OFFSET_MINUTES = 7 * 60;
const OPERATIONAL_DAY_START_MINUTES = 5 * 60;

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function isoWeekKey(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return '';
  const target = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const weekYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function getDashboardOperationalDate(
  record: Pick<FlightRecord, 'date' | 'schedule'> & Partial<Pick<FlightRecord, 'scheduledDate' | 'scheduledTime' | 'operationalDate'>>
): string {
  if (record.operationalDate) return record.operationalDate;
  const sourceDate = record.scheduledDate ?? record.date;
  const sourceTime = record.scheduledTime ?? record.schedule;
  const minutes = parseScheduleMinutes(sourceTime);
  if (minutes == null || minutes >= OPERATIONAL_DAY_START_MINUTES) return sourceDate;
  return addIsoDays(sourceDate, -1);
}

function recordMonthKey(record: FlightRecord): string {
  return monthKey(getDashboardOperationalDate(record));
}

function periodKey(record: FlightRecord, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  const operationalDate = getDashboardOperationalDate(record);
  if (mode === 'wow') return isoWeekKey(operationalDate);
  if (mode === 'yoy' && granularity === 'year') return operationalDate.slice(0, 4);
  return monthKey(operationalDate);
}

function periodLabel(key: string, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  if (mode === 'yoy' && granularity === 'year') return key || 'No period';
  if (mode === 'wow') {
    const match = /^(\d{4})-W(\d{2})$/.exec(key);
    return match ? `Week ${Number(match[2])} ${match[1]}` : key;
  }

  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const month = Number(match[2]) - 1;
  return `${MONTH_LABELS[month] ?? match[2]} ${match[1]}`;
}

export function listDashboardPeriods(
  records: FlightRecord[],
  mode: DashboardComparisonMode,
  granularity: DashboardComparisonGranularity = 'month'
): Array<{ key: string; label: string }> {
  return Array.from(new Set(records.map((record) => periodKey(record, mode, granularity)).filter(Boolean)))
    .sort()
    .map((key) => ({ key, label: periodLabel(key, mode, granularity) }));
}

function recordValue(record: FlightRecord, metric: DashboardMetric): number {
  if (metric === 'pax') return Number.isFinite(record.pax) ? Number(record.pax) : 0;
  return 1;
}

function recordPax(record: FlightRecord): number {
  return Number.isFinite(record.pax) ? Number(record.pax) : 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseScheduleMinutes(schedule: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatHourBucket(schedule: string, timeBasis: DashboardTimeBasis): string {
  const minutes = parseScheduleMinutes(schedule);
  if (minutes == null) return 'Unknown';
  const shifted = shiftMinutesForBasis(minutes, timeBasis);
  const bucketHour = Math.floor(shifted / 60);
  return `${String(bucketHour).padStart(2, '0')}:00`;
}

function shiftMinutesForBasis(minutes: number, timeBasis: DashboardTimeBasis): number {
  return timeBasis === 'utc'
    ? (minutes - LOCAL_UTC_OFFSET_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY
    : minutes;
}

function shiftedScheduleMinutes(schedule: string, timeBasis: DashboardTimeBasis): number | null {
  const minutes = parseScheduleMinutes(schedule);
  if (minutes == null) return null;
  return shiftMinutesForBasis(minutes, timeBasis);
}

function formatHalfHourBucket(minutes: number): string {
  const bucket = Math.floor(minutes / 30) * 30;
  return `${String(Math.floor(bucket / 60)).padStart(2, '0')}:${String(bucket % 60).padStart(2, '0')}`;
}

function operationalStartMinutes(timeBasis: DashboardTimeBasis): number {
  return shiftMinutesForBasis(OPERATIONAL_DAY_START_MINUTES, timeBasis);
}

function operationalHourBuckets(timeBasis: DashboardTimeBasis): string[] {
  const start = operationalStartMinutes(timeBasis);
  return Array.from({ length: 48 }, (_, index) => formatHalfHourBucket((start + index * 30) % MINUTES_PER_DAY));
}

export function buildPeakHourAxisTicks(timeBasis: DashboardTimeBasis): DashboardPeakHourAxisTick[] {
  const start = operationalStartMinutes(timeBasis);
  return Array.from({ length: 13 }, (_, tickIndex) => {
    const elapsed = tickIndex * 120;
    const absoluteMinutes = start + elapsed;
    const dayOffset = Math.floor(absoluteMinutes / MINUTES_PER_DAY);
    return {
      index: tickIndex * 4,
      label: `${formatHalfHourBucket(absoluteMinutes % MINUTES_PER_DAY)}${dayOffset > 0 ? ` +${dayOffset}` : ''}`,
    };
  });
}

function addIsoDays(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dimensionKey(
  record: FlightRecord,
  dimension: DashboardDimension,
  timeBasis: DashboardTimeBasis,
  routeCountries?: RouteCountryMapping[]
): string {
  if (dimension === 'airline') return record.airline || 'Unknown';
  if (dimension === 'route') return record.route || 'Unknown';
  if (dimension === 'country') return resolveCountryForRoute(record.route, routeCountries);
  if (dimension === 'aircraft') return record.aircraft || 'Unknown';
  if (dimension === 'type') return record.type;
  if (dimension === 'dayOfWeek') {
    const parsed = parseIsoDate(getDashboardOperationalDate(record));
    return parsed ? WEEKDAY_LABELS[parsed.getUTCDay()] : 'Unknown';
  }
  if (dimension === 'hourBucket') return formatHourBucket(record.schedule, timeBasis);
  return record.flightNumber || record.rawFlightNumber || 'Unknown';
}

function buildRankRows(
  records: FlightRecord[],
  keyForRecord: (record: FlightRecord) => string,
  totalFlights: number
): DashboardOverviewRankRow[] {
  const groups = new Map<string, { flights: number; pax: number }>();
  for (const record of records) {
    const key = keyForRecord(record) || 'Unknown';
    const current = groups.get(key) ?? { flights: 0, pax: 0 };
    current.flights += 1;
    current.pax += recordPax(record);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, value]) => ({
      key,
      label: key,
      flights: value.flights,
      pax: value.pax,
      share: totalFlights === 0 ? 0 : value.flights / totalFlights,
    }))
    .sort((a, b) => b.flights - a.flights || b.pax - a.pax || a.label.localeCompare(b.label));
}

function emptyRank(label = '-'): DashboardOverviewRankRow {
  return { key: label, label, flights: 0, pax: 0, share: 0 };
}

function buildMonthlyTrend(records: FlightRecord[]): DashboardOverviewMonthRow[] {
  const groups = new Map<string, DashboardOverviewMonthRow>();
  for (const record of records) {
    const key = recordMonthKey(record);
    const current = groups.get(key) ?? {
      key,
      label: periodLabel(key, 'mom'),
      arrivals: 0,
      departures: 0,
      total: 0,
      pax: 0,
    };
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    current.total += 1;
    current.pax += recordPax(record);
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function filterRecordsByMonth(records: FlightRecord[], month: string | undefined): FlightRecord[] {
  if (!month || month === 'all') return records;
  return records.filter((record) => recordMonthKey(record) === month);
}

function buildDailyTrend(records: FlightRecord[]): DashboardOverviewDailyRow[] {
  const groups = new Map<string, DashboardOverviewDailyRow>();
  for (const record of records) {
    const operationalDate = getDashboardOperationalDate(record);
    const parsed = parseIsoDate(operationalDate);
    const month = monthKey(operationalDate);
    const day = parsed ? String(parsed.getUTCDate()).padStart(2, '0') : operationalDate.slice(8, 10) || operationalDate;
    const current = groups.get(operationalDate) ?? {
      date: operationalDate,
      month,
      day,
      label: parsed ? `${MONTH_LABELS[parsed.getUTCMonth()] ?? month} ${day}` : operationalDate,
      weekday: parsed ? WEEKDAY_LABELS[parsed.getUTCDay()] : 'Unknown',
      arrivals: 0,
      departures: 0,
      total: 0,
      pax: 0,
    };
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    current.total += 1;
    current.pax += recordPax(record);
    groups.set(operationalDate, current);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildCountryRouteContribution(
  records: FlightRecord[],
  totalFlights: number,
  routeCountries?: RouteCountryMapping[]
): DashboardOverviewCountryRouteRow[] {
  const groups = new Map<string, { country: string; route: string; flights: number; pax: number }>();
  for (const record of records) {
    const country = resolveCountryForRoute(record.route, routeCountries);
    const route = record.route || 'Unknown';
    const key = `${country}|${route}`;
    const current = groups.get(key) ?? { country, route, flights: 0, pax: 0 };
    current.flights += 1;
    current.pax += recordPax(record);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((row) => ({ ...row, share: totalFlights === 0 ? 0 : row.flights / totalFlights }))
    .sort((a, b) => b.flights - a.flights || a.country.localeCompare(b.country) || a.route.localeCompare(b.route));
}

function buildWeekdayHeatmap(records: FlightRecord[]): DashboardOverviewHeatmapCell[] {
  const groups = new Map<string, { month: string; weekday: string; flights: number; dates: Set<string> }>();
  for (const record of records) {
    const operationalDate = getDashboardOperationalDate(record);
    const parsed = parseIsoDate(operationalDate);
    if (!parsed) continue;
    const month = monthKey(operationalDate);
    const weekday = WEEKDAY_LABELS[parsed.getUTCDay()];
    const key = `${month}|${weekday}`;
    const current = groups.get(key) ?? { month, weekday, flights: 0, dates: new Set<string>() };
    current.flights += 1;
    current.dates.add(operationalDate);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((cell) => ({
      month: cell.month,
      monthLabel: periodLabel(cell.month, 'mom'),
      weekday: cell.weekday,
      flights: cell.flights,
      operatingDays: cell.dates.size,
      avgFlightsPerDay: cell.dates.size === 0 ? 0 : roundMetric(cell.flights / cell.dates.size),
    }))
    .sort((a, b) => a.month.localeCompare(b.month) || WEEKDAY_LABELS.indexOf(a.weekday) - WEEKDAY_LABELS.indexOf(b.weekday));
}

function buildPeakHourAverage(records: FlightRecord[], timeBasis: DashboardTimeBasis): DashboardOverviewPeakHourRow[] {
  const bucketOrder = operationalHourBuckets(timeBasis);
  const buckets = new Map(bucketOrder.map((bucket) => [bucket, {
    flights: 0,
    arrivals: 0,
    departures: 0,
    dates: new Set<string>(),
  }]));
  for (const record of records) {
    const minutes = shiftedScheduleMinutes(record.schedule, timeBasis);
    if (minutes == null) continue;
    const bucket = formatHalfHourBucket(minutes);
    const current = buckets.get(bucket) ?? {
      flights: 0,
      arrivals: 0,
      departures: 0,
      dates: new Set<string>(),
    };
    current.flights += 1;
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    current.dates.add(getDashboardOperationalDate(record));
    buckets.set(bucket, current);
  }
  return bucketOrder.map((bucket) => {
    const value = buckets.get(bucket) ?? {
      flights: 0,
      arrivals: 0,
      departures: 0,
      dates: new Set<string>(),
    };
    return {
      bucket,
      flights: value.flights,
      arrivals: value.arrivals,
      departures: value.departures,
      operatingDays: value.dates.size,
      avgFlightsPerDay: value.dates.size === 0 ? 0 : roundMetric(value.flights / value.dates.size),
      avgArrivalsPerDay: value.dates.size === 0 ? 0 : roundMetric(value.arrivals / value.dates.size),
      avgDeparturesPerDay: value.dates.size === 0 ? 0 : roundMetric(value.departures / value.dates.size),
    };
  });
}

function applyRecordModification(record: FlightRecord, mod: FlightModification | undefined): FlightRecord | null {
  if (!mod) return record.status === 'deleted' ? null : record;
  if (mod.action === 'deleted') return null;
  if (mod.action === 'added' && mod.addedLeg) return { ...record, ...mod.addedLeg } as FlightRecord;
  return {
    ...record,
    schedule: mod.schedule ?? record.schedule,
    aircraft: mod.aircraft ?? record.aircraft,
    route: mod.route ?? record.route,
    codeShares: 'codeShares' in mod ? mod.codeShares ?? null : record.codeShares,
    pax: 'pax' in mod ? mod.pax ?? null : record.pax,
    gate: 'gate' in mod ? mod.gate ?? null : record.gate,
    stand: 'stand' in mod ? mod.stand ?? null : record.stand,
    counter: 'counter' in mod ? mod.counter ?? null : record.counter,
    carousel: 'carousel' in mod ? mod.carousel ?? null : record.carousel,
    mct: 'mct' in mod ? mod.mct ?? null : record.mct,
    fb: 'fb' in mod ? mod.fb ?? null : record.fb,
    lb: 'lb' in mod ? mod.lb ?? null : record.lb,
    bhs: 'bhs' in mod ? mod.bhs ?? null : record.bhs,
    ghs: 'ghs' in mod ? mod.ghs ?? null : record.ghs,
    action: 'modified',
  };
}

export function buildEffectiveDashboardRecords(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>
): FlightRecord[] {
  const next = records
    .map((record) => applyRecordModification(record, modifications.get(record.id)))
    .filter((record): record is FlightRecord => record != null && record.status !== 'deleted');

  const existingIds = new Set(records.map((record) => record.id));
  for (const mod of modifications.values()) {
    if (mod.action === 'added' && mod.addedLeg && !existingIds.has(mod.legId)) {
      next.push({ ...mod.addedLeg, action: 'added' } as FlightRecord);
    }
  }

  return next;
}

export function buildDashboardOverview(input: DashboardOverviewInput): DashboardOverviewResult {
  const baseRecords = input.records.filter((record) => (
    record.status !== 'deleted' &&
    (input.typeFilter === 'all' || record.type === input.typeFilter) &&
    (!input.monthFrom || recordMonthKey(record) >= input.monthFrom) &&
    (!input.monthTo || recordMonthKey(record) <= input.monthTo)
  ));

  const airlineOptions = Array.from(new Set(baseRecords.map((record) => record.airline).filter(Boolean))).sort();
  const countryOptions = Array.from(new Set(baseRecords.map((record) => resolveCountryForRoute(record.route, input.routeCountries)).filter(Boolean))).sort();
  const routeOptions = Array.from(new Set(baseRecords.map((record) => record.route).filter(Boolean))).sort();

  const filteredRecords = baseRecords.filter((record) => (
    (!input.airline || input.airline === 'all' || record.airline === input.airline) &&
    (!input.country || input.country === 'all' || resolveCountryForRoute(record.route, input.routeCountries) === input.country) &&
    (!input.route || input.route === 'all' || record.route === input.route)
  ));

  const totalFlights = filteredRecords.length;
  const totalPax = filteredRecords.reduce((sum, record) => sum + recordPax(record), 0);
  const uniqueDates = new Set(filteredRecords.map((record) => getDashboardOperationalDate(record)));
  const monthlyTrend = buildMonthlyTrend(filteredRecords);
  const airlineRanking = buildRankRows(filteredRecords, (record) => record.airline || 'Unknown', totalFlights);
  const routeRanking = buildRankRows(filteredRecords, (record) => record.route || 'Unknown', totalFlights);
  const monthRanking = monthlyTrend
    .map((row) => ({ key: row.key, label: row.label, flights: row.total, pax: row.pax, share: totalFlights === 0 ? 0 : row.total / totalFlights }))
    .sort((a, b) => b.flights - a.flights || a.key.localeCompare(b.key));
  const aircraftMix = buildRankRows(filteredRecords, (record) => record.aircraft || 'Unknown', totalFlights);

  return {
    records: filteredRecords,
    airlineOptions,
    countryOptions,
    routeOptions,
    kpis: {
      totalFlights,
      totalPax,
      avgFlightsPerDay: uniqueDates.size === 0 ? 0 : roundMetric(totalFlights / uniqueDates.size),
      peakMonth: monthRanking[0] ?? emptyRank(),
      topAirline: airlineRanking[0] ?? emptyRank(),
      topRoute: routeRanking[0] ?? emptyRank(),
    },
    monthlyTrend,
    dailyTrend: buildDailyTrend(filteredRecords),
    airlineRanking,
    countryRouteContribution: buildCountryRouteContribution(filteredRecords, totalFlights, input.routeCountries),
    weekdayHeatmap: buildWeekdayHeatmap(filteredRecords),
    aircraftMix,
    peakHourAverage: buildPeakHourAverage(filterRecordsByMonth(filteredRecords, input.peakHourMonth), input.timeBasis),
  };
}

function summarizePeriod(
  records: FlightRecord[],
  key: string,
  label: string,
  metric: DashboardMetric
): DashboardPeriodSummary {
  return {
    key,
    label,
    recordCount: records.length,
    total: records.reduce((sum, record) => sum + recordValue(record, metric), 0),
  };
}

function groupValues(
  records: FlightRecord[],
  metric: DashboardMetric,
  dimension: DashboardDimension,
  timeBasis: DashboardTimeBasis,
  routeCountries?: RouteCountryMapping[]
): Map<string, number> {
  const values = new Map<string, number>();
  for (const record of records) {
    const key = dimensionKey(record, dimension, timeBasis, routeCountries);
    values.set(key, (values.get(key) ?? 0) + recordValue(record, metric));
  }
  return values;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function buildDrivers({
  currentValues,
  previousValues,
  currentTotal,
  previousTotal,
}: {
  currentValues: Map<string, number>;
  previousValues: Map<string, number>;
  currentTotal: number;
  previousTotal: number;
}): DashboardDriverContribution[] {
  const keys = new Set([...currentValues.keys(), ...previousValues.keys()]);
  return [...keys].map((key) => {
    const currentValue = currentValues.get(key) ?? 0;
    const previousValue = previousValues.get(key) ?? 0;
    const delta = currentValue - previousValue;
    const currentShare = currentTotal === 0 ? 0 : currentValue / currentTotal;
    const previousShare = previousTotal === 0 ? 0 : previousValue / previousTotal;
    return {
      key,
      label: key,
      currentValue,
      previousValue,
      delta,
      deltaPct: safeRatio(delta, previousValue),
      ctgPct: safeRatio(delta, previousTotal),
      currentShare,
      previousShare,
      shareShift: currentShare - previousShare,
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.currentValue - a.currentValue || a.label.localeCompare(b.label));
}

export function buildDashboardComparison(input: DashboardComparisonInput): DashboardComparisonResult {
  const granularity = input.granularity ?? 'month';
  const filtered = input.records.filter((record) => (
    record.status !== 'deleted' &&
    (input.typeFilter === 'all' || record.type === input.typeFilter)
  ));
  const currentRecords = filtered.filter((record) => periodKey(record, input.mode, granularity) === input.currentPeriod);
  const previousRecords = filtered.filter((record) => periodKey(record, input.mode, granularity) === input.previousPeriod);
  const currentLabel = periodLabel(input.currentPeriod, input.mode, granularity);
  const previousLabel = periodLabel(input.previousPeriod, input.mode, granularity);
  const current = summarizePeriod(currentRecords, input.currentPeriod, currentLabel, input.metric);
  const previous = summarizePeriod(previousRecords, input.previousPeriod, previousLabel, input.metric);
  const delta = current.total - previous.total;
  const currentValues = groupValues(currentRecords, input.metric, input.dimension, input.timeBasis, input.routeCountries);
  const previousValues = groupValues(previousRecords, input.metric, input.dimension, input.timeBasis, input.routeCountries);
  const drivers = buildDrivers({
    currentValues,
    previousValues,
    currentTotal: current.total,
    previousTotal: previous.total,
  });

  return {
    mode: input.mode,
    granularity,
    metric: input.metric,
    dimension: input.dimension,
    typeFilter: input.typeFilter,
    timeBasis: input.timeBasis,
    status: current.recordCount === 0 && previous.recordCount === 0 ? 'empty' : current.recordCount === 0 || previous.recordCount === 0 ? 'partial' : 'ready',
    current,
    previous,
    delta,
    deltaPct: safeRatio(delta, previous.total),
    periodLabels: {
      current: currentLabel,
      previous: previousLabel,
    },
    drivers,
  };
}
