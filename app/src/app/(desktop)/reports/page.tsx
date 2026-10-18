'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { TrafficReportModePanel } from '@/app/(desktop)/dashboard/components/TrafficReportModePanel';
import {
  buildDashboardComparison,
  formatPct,
  formatPointPct,
  getDashboardOperationalDate,
  listDashboardPeriods,
  type DashboardComparisonGranularity,
  type DashboardComparisonMode,
  type DashboardComparisonResult,
  type DashboardDimension,
  type DashboardDriverContribution,
  type DashboardMetric,
  type DashboardTimeBasis,
  type DashboardTypeFilter,
} from '@/lib/dashboardAnalysis';
import { computePaxCoverage } from '@/lib/operationalDashboardAnalysis';
import {
  buildDashboardReportFileName,
  buildMomWowAnalysisWorkbook,
  buildSanLuongSummaryWorkbook,
  downloadDashboardWorkbook,
  type DashboardComparisonReportContext,
} from '@/lib/dashboardReportExport';
import {
  getOperationalScheduleAllocationWindowV1,
  getOperationalSettings,
  getSeasons,
  loadSeasonWorkspaceWindow,
} from '@/lib/remoteStore';
import {
  isOperationalScheduleV1Enabled,
  loadFullOperationalScheduleWindow,
} from '@/lib/operationalScheduleContract';
import { listRouteCountries, resolveCountryForRoute } from '@/lib/routeCountry';
import type { FlightRecord, RouteCountryMapping, Season } from '@/lib/types';
import { formatUiError } from '@/lib/uiDisplayText';
const MONTH_LABELS = [
  'Thg 1', 'Thg 2', 'Thg 3', 'Thg 4', 'Thg 5', 'Thg 6',
  'Thg 7', 'Thg 8', 'Thg 9', 'Thg 10', 'Thg 11', 'Thg 12',
];

const WEEKDAY_KEYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const METRICS: Array<{ value: DashboardMetric; label: string }> = [
  { value: 'flights', label: 'Chuyến bay' },
  { value: 'pax', label: 'Khách' },
];

const TYPE_FILTERS: Array<{ value: DashboardTypeFilter; label: string }> = [
  { value: 'all', label: 'Tất cả' },
  { value: 'A', label: 'Đến (ARR)' },
  { value: 'D', label: 'Đi (DEP)' },
];

const DRIVER_TABS: Array<{ value: DashboardDimension; label: string; icon: string }> = [
  { value: 'airline', label: 'Hãng bay', icon: 'airlines' },
  { value: 'route', label: 'Đường bay', icon: 'flight_takeoff' },
  { value: 'country', label: 'Quốc gia', icon: 'public' },
  { value: 'aircraft', label: 'Tàu bay', icon: 'flight' },
  { value: 'type', label: 'Loại chuyến', icon: 'swap_horiz' },
  { value: 'dayOfWeek', label: 'Thứ', icon: 'calendar_today' },
  { value: 'hourBucket', label: 'Giờ', icon: 'schedule' },
  { value: 'flightNumber', label: 'Số hiệu', icon: 'tag' },
];

const WATERFALL_DIMENSIONS: Array<{ value: DashboardDimension; label: string }> = [
  { value: 'airline', label: 'Hãng bay' },
  { value: 'country', label: 'Quốc gia' },
  { value: 'route', label: 'Đường bay' },
  { value: 'aircraft', label: 'Tàu bay' },
  { value: 'dayOfWeek', label: 'Thứ' },
  { value: 'hourBucket', label: 'Giờ' },
];

const numberFormat = new Intl.NumberFormat('en-US');

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return numberFormat.format(Math.round(value));
}

function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${numberFormat.format(Math.round(value))}`;
}

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isoWeekKey(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return '';
  const target = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
  return `${target.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function periodKey(record: FlightRecord, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  const operationalDate = getDashboardOperationalDate(record);
  if (mode === 'wow') return isoWeekKey(operationalDate);
  if (mode === 'yoy' && granularity === 'year') return operationalDate.slice(0, 4);
  return operationalDate.slice(0, 7);
}

function periodLabel(key: string, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  if (mode === 'yoy' && granularity === 'year') return key || 'Không có kỳ';
  if (mode === 'wow') {
    const match = /^(\d{4})-W(\d{2})$/.exec(key);
    return match ? `Tuần ${Number(match[2])} ${match[1]}` : key;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key || 'Không có kỳ';
  return `${MONTH_LABELS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

function monthDateKeys(month: string): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

function resolveDefaultPreviousPeriod(
  periods: Array<{ key: string }>,
  currentPeriod: string,
  mode: DashboardComparisonMode,
  granularity: DashboardComparisonGranularity
): string {
  if (mode === 'yoy') {
    const match = granularity === 'year'
      ? /^(\d{4})$/.exec(currentPeriod)
      : /^(\d{4})-(\d{2})$/.exec(currentPeriod);
    if (match) {
      const previousKey = granularity === 'year'
        ? String(Number(match[1]) - 1)
        : `${Number(match[1]) - 1}-${match[2]}`;
      if (periods.some((p) => p.key === previousKey)) return previousKey;
    }
  }
  const currentIndex = periods.findIndex((p) => p.key === currentPeriod);
  return currentIndex > 0 ? periods[currentIndex - 1]?.key ?? '' : '';
}

function operationalRecordPax(record: { pax?: number | null }): number {
  return Number.isFinite(record.pax) ? Number(record.pax) : 0;
}

function metricValueForRecord(record: FlightRecord, metric: DashboardMetric): number {
  return metric === 'pax' ? operationalRecordPax(record) : 1;
}

function hourBucket(schedule: string, timeBasis: DashboardTimeBasis): string {
  const [h = '0', m = '0'] = schedule.split(':');
  const baseMinutes = Number(h) * 60 + Number(m);
  const shifted = timeBasis === 'utc' ? (baseMinutes - 420 + 1440) % 1440 : baseMinutes;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:00`;
}

function dimensionValue(
  record: FlightRecord,
  dimension: DashboardDimension,
  timeBasis: DashboardTimeBasis,
  routeCountries?: RouteCountryMapping[]
): string {
  if (dimension === 'airline') return record.airline || 'Không rõ';
  if (dimension === 'route') return record.route || 'Không rõ';
  if (dimension === 'country') return resolveCountryForRoute(record.route, routeCountries);
  if (dimension === 'aircraft') return record.aircraft || 'Không rõ';
  if (dimension === 'type') return record.type;
  if (dimension === 'dayOfWeek') {
    const parsed = parseIsoDate(getDashboardOperationalDate(record));
    return parsed ? WEEKDAY_KEYS[parsed.getUTCDay()] ?? 'Không rõ' : 'Không rõ';
  }
  if (dimension === 'hourBucket') return hourBucket(record.schedule, timeBasis);
  return record.flightNumber || record.rawFlightNumber || 'Không rõ';
}

type DashboardComparisonTrendRow = {
  key: string;
  label: string;
  value: number;
  flights: number;
  arrivals: number;
  departures: number;
  pax: number;
  day?: string;
};

function summarizeComparisonRecordsByMonth(records: FlightRecord[], metric: DashboardMetric): DashboardComparisonTrendRow[] {
  const groups = new Map<string, DashboardComparisonTrendRow>();
  for (const record of records) {
    if (record.status === 'deleted') continue;
    const date = getDashboardOperationalDate(record);
    const key = date.slice(0, 7);
    if (!key) continue;
    const current = groups.get(key) ?? {
      key,
      label: periodLabel(key, 'mom'),
      value: 0,
      flights: 0,
      arrivals: 0,
      departures: 0,
      pax: 0,
    };
    current.value += metricValueForRecord(record, metric);
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeComparisonRecordsByDate(records: FlightRecord[], metric: DashboardMetric): DashboardComparisonTrendRow[] {
  const groups = new Map<string, DashboardComparisonTrendRow>();
  for (const record of records) {
    if (record.status === 'deleted') continue;
    const date = getDashboardOperationalDate(record);
    if (!date) continue;
    const current = groups.get(date) ?? {
      key: date,
      label: date,
      day: date.slice(8, 10),
      value: 0,
      flights: 0,
      arrivals: 0,
      departures: 0,
      pax: 0,
    };
    current.value += metricValueForRecord(record, metric);
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(date, current);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function trendBarHeight(value: number, maxValue: number): string {
  if (value <= 0 || maxValue <= 0) return '0%';
  return `${Math.max(4, (value / maxValue) * 100)}%`;
}
const EMPTY_RECORDS: FlightRecord[] = [];

function ReportsContent() {
  const searchParams = useSearchParams();
  const seasonParam = searchParams?.get('season') ?? null;

  // Active sub-tab in Reports
  const [activeTab, setActiveTab] = useState<'traffic-report' | 'comparison'>('traffic-report');

  // Seasons & Records state for Comparison tab
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>('');
  const [loadedSeasonId, setLoadedSeasonId] = useState<string | null>(null);
  const [rawEffectiveRecords, setRawEffectiveRecords] = useState<FlightRecord[]>([]);
  const [routeCountries, setRouteCountries] = useState<RouteCountryMapping[]>(() => listRouteCountries());

  // Derived effectiveRecords: valid only for currently selectedSeasonId with stable empty fallback
  const effectiveRecords = useMemo(() => {
    if (selectedSeasonId && loadedSeasonId === selectedSeasonId) {
      return rawEffectiveRecords;
    }
    return EMPTY_RECORDS;
  }, [selectedSeasonId, loadedSeasonId, rawEffectiveRecords]);
  const loadingData = Boolean(selectedSeasonId) && loadedSeasonId !== selectedSeasonId;
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Comparison filter parameters
  const [comparisonMode, setComparisonMode] = useState<DashboardComparisonMode>('mom');
  const [comparisonGranularity, setComparisonGranularity] = useState<DashboardComparisonGranularity>('month');
  const [metric, setMetric] = useState<DashboardMetric>('flights');
  const [typeFilter, setTypeFilter] = useState<DashboardTypeFilter>('all');
  const [timeBasis, setTimeBasis] = useState<DashboardTimeBasis>('local');
  const [dimension, setDimension] = useState<DashboardDimension>('airline');
  const [currentPeriod, setCurrentPeriod] = useState<string>('');
  const [previousPeriod, setPreviousPeriod] = useState<string>('');
  const [selectedDriverKey, setSelectedDriverKey] = useState<string>('');
  const [driverSortField, setDriverSortField] = useState<'ctg' | 'delta' | 'current'>('ctg');
  const [driverSortDirection, setDriverSortDirection] = useState<'desc' | 'asc'>('desc');
  const [showAllDrivers, setShowAllDrivers] = useState(false);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [comparisonTrendMonth, setComparisonTrendMonth] = useState<string>('');

  // Initial load of seasons & mappings
  useEffect(() => {
    let cancelled = false;
    getSeasons()
      .then((res) => {
        if (cancelled) return;
        setSeasons(res);
        const match = seasonParam && res.find((s) => s.id === seasonParam);
        const initial = match ? match.id : res[0]?.id ?? '';
        setSelectedSeasonId(initial);
      })
      .catch(() => {});

    getOperationalSettings()
      .then((settings) => {
        if (!cancelled && settings?.routeCountries && settings.routeCountries.length > 0) {
          setRouteCountries(settings.routeCountries);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [seasonParam]);

  // Load flights for selected season in Comparison mode (using original Operational / Workspace loader)
  useEffect(() => {
    const targetSeason = seasons.find((s) => s.id === selectedSeasonId);
    if (!targetSeason) {
      return;
    }
    let cancelled = false;
    // loadingData is derived from loadedSeasonId !== selectedSeasonId

    const loadRecords = async () => {
      try {
        if (isOperationalScheduleV1Enabled()) {
          const operationalResult = await loadFullOperationalScheduleWindow({
            startDate: targetSeason.effectiveStart,
            endDate: targetSeason.effectiveEnd,
            resourceType: 'all',
            fetchWindowFn: (p) => getOperationalScheduleAllocationWindowV1(p),
          });
          if (!cancelled) {
            setRawEffectiveRecords(operationalResult.records);
            setLoadedSeasonId(targetSeason.id);
          }
        } else {
          const result = await loadSeasonWorkspaceWindow({
            seasonId: targetSeason.id,
            resourceType: 'schedule',
            limit: 100000,
          });
          if (!cancelled) {
            setRawEffectiveRecords(result?.records ?? []);
            setLoadedSeasonId(targetSeason.id);
          }
        }
      } catch {
        if (!cancelled) {
          setRawEffectiveRecords([]);
          setLoadedSeasonId(targetSeason.id);
        }
      } finally {
        // loadingData automatically resolves when loadedSeasonId updates
      }
    };

    void loadRecords();

    return () => {
      cancelled = true;
    };
  }, [selectedSeasonId, seasons]);

  // Available period options for current comparison mode
  const periodOptions = useMemo(() => {
    if (effectiveRecords.length === 0) return [];
    return listDashboardPeriods(effectiveRecords, comparisonMode, comparisonGranularity);
  }, [effectiveRecords, comparisonMode, comparisonGranularity]);

  const activeCurrentPeriod = periodOptions.some((p) => p.key === currentPeriod)
    ? currentPeriod
    : periodOptions[periodOptions.length - 1]?.key ?? '';

  const defaultPreviousPeriod = useMemo(() => {
    return resolveDefaultPreviousPeriod(
      periodOptions,
      activeCurrentPeriod,
      comparisonMode,
      comparisonMode === 'yoy' ? comparisonGranularity : 'month'
    );
  }, [periodOptions, activeCurrentPeriod, comparisonMode, comparisonGranularity]);

  const activePreviousPeriod = periodOptions.some((p) => p.key === previousPeriod) && previousPeriod !== activeCurrentPeriod
    ? previousPeriod
    : defaultPreviousPeriod;

  const comparisonGranularityForBuild = comparisonMode === 'yoy' ? comparisonGranularity : 'month';

  const comparisonScopedRecords = useMemo(() => {
    if (!activeCurrentPeriod) return [];
    const periodKeys = new Set([activeCurrentPeriod, activePreviousPeriod].filter(Boolean));
    return effectiveRecords.filter((record) => (
      record.status !== 'deleted' &&
      (typeFilter === 'all' || record.type === typeFilter) &&
      periodKeys.has(periodKey(record, comparisonMode, comparisonGranularityForBuild))
    ));
  }, [activeCurrentPeriod, activePreviousPeriod, effectiveRecords, comparisonGranularityForBuild, comparisonMode, typeFilter]);

  const comparisonPaxCoverage = useMemo(() => {
    return computePaxCoverage(comparisonScopedRecords);
  }, [comparisonScopedRecords]);

  const comparisonTrendRecords = useMemo(() => {
    return effectiveRecords.filter((record) => (
      record.status !== 'deleted' &&
      (typeFilter === 'all' || record.type === typeFilter)
    ));
  }, [effectiveRecords, typeFilter]);

  const comparisonMonthlyTrendRows = useMemo(() => {
    return summarizeComparisonRecordsByMonth(comparisonTrendRecords, metric);
  }, [comparisonTrendRecords, metric]);

  const defaultComparisonTrendMonth = useMemo(() => {
    if (/^\d{4}-\d{2}$/.test(activeCurrentPeriod) && comparisonMonthlyTrendRows.some((row) => row.key === activeCurrentPeriod)) {
      return activeCurrentPeriod;
    }
    return comparisonMonthlyTrendRows[comparisonMonthlyTrendRows.length - 1]?.key ?? '';
  }, [activeCurrentPeriod, comparisonMonthlyTrendRows]);

  const activeComparisonTrendMonth = comparisonMonthlyTrendRows.some((row) => row.key === comparisonTrendMonth)
    ? comparisonTrendMonth
    : defaultComparisonTrendMonth;

  const comparisonDailyTrendRows = useMemo(() => {
    if (!activeComparisonTrendMonth) return [];
    const sourceRows = summarizeComparisonRecordsByDate(
      comparisonTrendRecords.filter((record) => getDashboardOperationalDate(record).slice(0, 7) === activeComparisonTrendMonth),
      metric
    );
    const byDate = new Map(sourceRows.map((row) => [row.key, row]));
    return monthDateKeys(activeComparisonTrendMonth).map((date) => (
      byDate.get(date) ?? {
        key: date,
        label: date,
        day: date.slice(8, 10),
        value: 0,
        flights: 0,
        arrivals: 0,
        departures: 0,
        pax: 0,
      }
    ));
  }, [activeComparisonTrendMonth, comparisonTrendRecords, metric]);

  const comparisonMaxMonthlyTrend = Math.max(1, ...comparisonMonthlyTrendRows.map((row) => row.value));
  const comparisonMaxDailyTrend = Math.max(1, ...comparisonDailyTrendRows.map((row) => row.value));
  const comparisonTrendMetricLabel = metric === 'pax' ? 'Khách' : 'Chuyến bay';

  // Core comparison calculation
  const comparison: DashboardComparisonResult | null = useMemo(() => {
    if (!activeCurrentPeriod) return null;
    return buildDashboardComparison({
      records: effectiveRecords,
      mode: comparisonMode,
      granularity: comparisonGranularityForBuild,
      metric,
      currentPeriod: activeCurrentPeriod,
      previousPeriod: activePreviousPeriod,
      typeFilter,
      timeBasis,
      dimension,
      routeCountries,
    });
  }, [
    activeCurrentPeriod,
    activePreviousPeriod,
    effectiveRecords,
    comparisonGranularityForBuild,
    comparisonMode,
    dimension,
    metric,
    routeCountries,
    timeBasis,
    typeFilter,
  ]);

  const dimensionLabel = DRIVER_TABS.find((tab) => tab.value === dimension)?.label ?? 'Tác nhân';

  const waterfallRows = useMemo(() => {
    if (!activeCurrentPeriod) return [];
    return WATERFALL_DIMENSIONS.map((item) => {
      const result = buildDashboardComparison({
        records: effectiveRecords,
        mode: comparisonMode,
        granularity: comparisonGranularityForBuild,
        metric,
        currentPeriod: activeCurrentPeriod,
        previousPeriod: activePreviousPeriod,
        typeFilter,
        timeBasis,
        dimension: item.value,
        routeCountries,
      });
      const topDriver: DashboardDriverContribution | null = result.drivers[0] ?? null;
      const reconciledDelta = result.drivers.reduce((sum, driver) => sum + driver.delta, 0);
      return { ...item, result, topDriver, reconciledDelta };
    });
  }, [
    activeCurrentPeriod,
    activePreviousPeriod,
    effectiveRecords,
    comparisonGranularityForBuild,
    comparisonMode,
    metric,
    routeCountries,
    timeBasis,
    typeFilter,
  ]);

  const maxWaterfallDelta = Math.max(
    1,
    ...waterfallRows.map((row) => Math.abs(row.topDriver?.delta ?? 0))
  );

  const handleDriverSortClick = useCallback((field: 'ctg' | 'delta' | 'current') => {
    if (driverSortField === field) {
      setDriverSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setDriverSortField(field);
      setDriverSortDirection('desc');
    }
  }, [driverSortField]);

  const sortedDrivers = useMemo(() => {
    const list = [...(comparison?.drivers ?? [])];
    return list.sort((a, b) => {
      let cmp = 0;
      if (driverSortField === 'ctg') {
        cmp = Math.abs(b.ctgPct ?? 0) - Math.abs(a.ctgPct ?? 0) || Math.abs(b.delta) - Math.abs(a.delta);
      } else if (driverSortField === 'delta') {
        cmp = Math.abs(b.delta) - Math.abs(a.delta) || Math.abs(b.currentValue) - Math.abs(a.currentValue);
      } else if (driverSortField === 'current') {
        cmp = b.currentValue - a.currentValue;
      }
      return driverSortDirection === 'desc' ? cmp : -cmp;
    });
  }, [comparison?.drivers, driverSortField, driverSortDirection]);

  const displayedDrivers = useMemo(() => {
    return showAllDrivers ? sortedDrivers : sortedDrivers.slice(0, 15);
  }, [showAllDrivers, sortedDrivers]);

  const selectedDriver = useMemo(() => {
    return comparison?.drivers.find((driver) => driver.key === selectedDriverKey) ?? sortedDrivers[0] ?? comparison?.drivers[0] ?? null;
  }, [comparison, sortedDrivers, selectedDriverKey]);

  const selectedDriverRecords = useMemo(() => {
    if (!selectedDriver) return [];
    return effectiveRecords
      .filter((record) => (
        record.status !== 'deleted' &&
        (typeFilter === 'all' || record.type === typeFilter) &&
        (periodKey(record, comparisonMode, comparisonGranularityForBuild) === activeCurrentPeriod || periodKey(record, comparisonMode, comparisonGranularityForBuild) === activePreviousPeriod) &&
        dimensionValue(record, dimension, timeBasis, routeCountries) === selectedDriver.key
      ))
      .sort((a, b) => a.date.localeCompare(b.date) || a.schedule.localeCompare(b.schedule));
  }, [
    activeCurrentPeriod,
    activePreviousPeriod,
    effectiveRecords,
    comparisonGranularityForBuild,
    comparisonMode,
    dimension,
    routeCountries,
    selectedDriver,
    timeBasis,
    typeFilter,
  ]);

  const selectedDriverDrilldownRows = useMemo(() => {
    const groups = new Map<string, { date: string; flights: number; arrivals: number; departures: number; pax: number }>();
    for (const record of selectedDriverRecords) {
      const date = getDashboardOperationalDate(record);
      const current = groups.get(date) ?? { date, flights: 0, arrivals: 0, departures: 0, pax: 0 };
      current.flights += 1;
      current.pax += operationalRecordPax(record);
      if (record.type === 'A') current.arrivals += 1;
      if (record.type === 'D') current.departures += 1;
      groups.set(date, current);
    }
    return [...groups.values()].sort((a, b) => b.flights - a.flights || a.date.localeCompare(b.date));
  }, [selectedDriverRecords]);

  const topGain = comparison?.drivers.find((driver) => driver.delta > 0) ?? null;
  const topDrag = comparison?.drivers.find((driver) => driver.delta < 0) ?? null;
  const topCtg = useMemo(() => {
    return [...(comparison?.drivers ?? [])]
      .filter((driver) => driver.ctgPct != null)
      .sort((a, b) => Math.abs(b.ctgPct ?? 0) - Math.abs(a.ctgPct ?? 0))[0] ?? null;
  }, [comparison?.drivers]);

  const displayedSelectedRecords = useMemo(() => {
    return showAllRecords ? selectedDriverRecords : selectedDriverRecords.slice(0, 100);
  }, [showAllRecords, selectedDriverRecords]);
  const topMixRows = comparison?.drivers.slice(0, 6) ?? [];
  const maxMixShare = Math.max(0.01, ...topMixRows.flatMap((driver) => [driver.currentShare, driver.previousShare]));

  // Excel workbook exports
  const handleExportComparison = useCallback(async () => {
    if (!comparison) return;
    try {
      const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);
      const seasonCode = selectedSeason?.seasonCode || 'Season';

      const context: DashboardComparisonReportContext = {
        filters: {
          comparisonMode,
          metric,
          typeFilter,
          dimension,
          timeBasis,
        },
        comparison,
        waterfallRows: waterfallRows.map((r) => ({
          label: r.label,
          result: r.result,
          topDriver: r.topDriver,
          reconciledDelta: r.reconciledDelta,
        })),
        selectedDriver: selectedDriver ? { label: selectedDriver.label } : null,
        selectedDriverRecords: {
          totalRecords: selectedDriverRecords.length,
          includedRecords: selectedDriverRecords.length,
          truncated: false,
          records: selectedDriverRecords.slice(0, 200).map((r) => ({
            date: r.date,
            type: r.type,
            airline: r.airline,
            flightNumber: r.flightNumber,
            rawFlightNumber: r.rawFlightNumber,
            route: r.route,
            schedule: r.schedule,
            aircraft: r.aircraft,
            pax: r.pax,
          })),
        },
      };

      const workbook = buildMomWowAnalysisWorkbook({
        context,
        seasonCode,
      });

      const fileName = buildDashboardReportFileName('mom-wow-analysis', seasonCode);
      const res = await downloadDashboardWorkbook(workbook, fileName);
      setExportNotice(`Đã xuất báo cáo: ${res.fileName}`);
      setTimeout(() => setExportNotice(null), 4000);
    } catch (err: unknown) {
      setExportNotice(formatUiError(err, 'Lỗi xuất báo cáo'));
    }
  }, [comparison, seasons, selectedSeasonId, comparisonMode, metric, typeFilter, dimension, timeBasis, waterfallRows, selectedDriver, selectedDriverRecords]);

  const handleExportSanLuong = useCallback(async () => {
    if (effectiveRecords.length === 0) return;
    try {
      const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);
      const seasonCode = selectedSeason?.seasonCode || 'Season';

      const workbook = buildSanLuongSummaryWorkbook({
        records: effectiveRecords,
        routeCountries,
        seasonCode,
        timeBasis,
      });

      const fileName = buildDashboardReportFileName('sanluong-summary', seasonCode);
      const res = await downloadDashboardWorkbook(workbook, fileName);
      setExportNotice(`Đã xuất báo cáo: ${res.fileName}`);
      setTimeout(() => setExportNotice(null), 4000);
    } catch (err: unknown) {
      setExportNotice(formatUiError(err, 'Lỗi xuất báo cáo'));
    }
  }, [effectiveRecords, routeCountries, seasons, selectedSeasonId, timeBasis]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100 print:h-auto print:overflow-visible">
      {/* Top Header & Sub-tab Switcher */}
      <header className="flex-none border-b border-slate-200 bg-white px-5 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[24px] text-primary">assessment</span>
            <div>
              <h1 className="text-base font-bold text-slate-900 dark:text-white">Báo cáo & Phân tích Sản lượng</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Báo cáo và đối chiếu sản lượng; độc lập với nguồn Planning Dashboard.
              </p>
            </div>
          </div>

          {/* Sub-tab navigation */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1 dark:border-slate-700 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab('traffic-report')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'traffic-report'
                  ? 'bg-white text-primary shadow-sm dark:bg-slate-900 dark:text-primary-light'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">bar_chart</span>
              <span>Báo cáo sản lượng</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('comparison')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'comparison'
                  ? 'bg-white text-primary shadow-sm dark:bg-slate-900 dark:text-primary-light'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">compare_arrows</span>
              <span>So sánh sản lượng (MoM / WoW / YoY)</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-5 print:h-auto print:overflow-visible">
        {activeTab === 'traffic-report' ? (
          <TrafficReportModePanel />
        ) : (
          <div className="space-y-4">
            {/* Season & Control Bar for Comparison */}
            <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900 print:hidden">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Mùa:</span>
                    <select
                      value={selectedSeasonId}
                      onChange={(e) => setSelectedSeasonId(e.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {seasons.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.seasonCode} ({s.effectiveStart} - {s.effectiveEnd})
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Chỉ số:</span>
                    <select
                      value={metric}
                      onChange={(e) => setMetric(e.target.value as DashboardMetric)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {METRICS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setComparisonMode('mom')}
                      className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
                        comparisonMode === 'mom'
                          ? 'bg-white text-primary shadow-xs dark:bg-slate-900 dark:text-white'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                      }`}
                    >
                      MoM
                    </button>
                    <button
                      type="button"
                      onClick={() => setComparisonMode('wow')}
                      className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
                        comparisonMode === 'wow'
                          ? 'bg-white text-primary shadow-xs dark:bg-slate-900 dark:text-white'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                      }`}
                    >
                      WoW
                    </button>
                    <button
                      type="button"
                      onClick={() => setComparisonMode('yoy')}
                      className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
                        comparisonMode === 'yoy'
                          ? 'bg-white text-primary shadow-xs dark:bg-slate-900 dark:text-white'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                      }`}
                    >
                      YoY
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Cấp YoY:</span>
                    <select
                      value={comparisonGranularity}
                      onChange={(e) => setComparisonGranularity(e.target.value as DashboardComparisonGranularity)}
                      disabled={comparisonMode !== 'yoy'}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="month">Tháng</option>
                      <option value="year">Năm</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Loại:</span>
                    <select
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value as DashboardTypeFilter)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {TYPE_FILTERS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Múi giờ:</span>
                    <select
                      value={timeBasis}
                      onChange={(e) => setTimeBasis(e.target.value as DashboardTimeBasis)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="local">Địa phương (STA/STD)</option>
                      <option value="utc">UTC</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>Chiều phân tích:</span>
                    <select
                      value={dimension}
                      onChange={(e) => setDimension(e.target.value as DashboardDimension)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {DRIVER_TABS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportComparison}
                    disabled={!comparison || loadingData}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <span className="material-symbols-outlined text-[16px]">file_download</span>
                    <span>Xuất Excel So sánh</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportSanLuong}
                    disabled={effectiveRecords.length === 0 || loadingData}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary-dark disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">download</span>
                    <span>Xuất Excel Sản lượng</span>
                  </button>
                </div>
              </div>

              {/* Period Selectors Row */}
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
                <label className="flex items-center gap-2">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Kỳ hiện tại:</span>
                  <select
                    value={activeCurrentPeriod}
                    onChange={(e) => setCurrentPeriod(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {periodOptions.length === 0 ? (
                      <option value="">Không có kỳ</option>
                    ) : (
                      periodOptions.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label className="flex items-center gap-2">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Kỳ trước:</span>
                  <select
                    value={activePreviousPeriod}
                    onChange={(e) => setPreviousPeriod(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {activePreviousPeriod === '' && <option value="">Không có kỳ trước</option>}
                    {periodOptions.length === 0 ? (
                      <option value="">Không có kỳ</option>
                    ) : (
                      periodOptions.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                {comparison && (
                  <div className="ml-auto text-xs text-slate-500">
                    Số chuyến ghi nhận:{' '}
                    <span className="font-bold text-slate-700 dark:text-slate-200">
                      {comparison.current.recordCount.toLocaleString('en-US')}
                    </span>{' '}
                    (Kỳ hiện tại) /{' '}
                    <span className="font-bold text-slate-700 dark:text-slate-200">
                      {comparison.previous.recordCount.toLocaleString('en-US')}
                    </span>{' '}
                    (Kỳ trước)
                  </div>
                )}
              </div>
            </section>

            {/* Export notice alert */}
            {exportNotice && (
              <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-xs font-medium text-primary dark:text-primary-light">
                {exportNotice}
              </div>
            )}

            {/* Incomplete period banner */}
            {comparison && comparison.current.distinctDays !== comparison.previous.distinctDays && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-amber-600 dark:text-amber-400">warning</span>
                  <span>
                    Kỳ không đầy đủ: hiện tại {comparison.current.distinctDays} ngày, kỳ trước {comparison.previous.distinctDays} ngày — so sánh tổng có thể lệch
                  </span>
                </div>
                {comparison.dayAverageDelta !== null && comparison.dayAverageDelta !== undefined && (
                  <span className="font-semibold">
                    Chênh lệch bình quân/ngày: {formatDelta(Math.round(comparison.dayAverageDelta * 10) / 10)} {metric === 'pax' ? 'khách/ngày' : 'chuyến/ngày'}
                  </span>
                )}
              </div>
            )}

            {/* Pax coverage banner and missing pax warning chip */}
            {metric === 'pax' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <div>
                  Tỷ lệ phủ số liệu khách khả dụng: <span className="font-bold">{formatPct(comparisonPaxCoverage.coveragePct, { showSign: false })}</span>.
                  {' '}Khách thiếu số liệu &gt; 1 ngày: <span className="font-bold">{formatValue(comparisonPaxCoverage.missingAfterOneDay)}</span>.
                </div>
                {comparison && (comparison.current.missingPaxCount > 0 || comparison.previous.missingPaxCount > 0) && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                    <span className="material-symbols-outlined text-[13px]">info</span>
                    Tạm tính: {comparison.current.missingPaxCount > 0 && comparison.previous.missingPaxCount > 0 ? `hiện tại ${comparison.current.missingPaxCount}, kỳ trước ${comparison.previous.missingPaxCount}` : (comparison.current.missingPaxCount || comparison.previous.missingPaxCount)} chặng chưa có số khách
                  </span>
                )}
              </div>
            )}

            {/* 7 KPI Cards */}
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {[
                { label: 'Hiện tại', value: formatValue(comparison?.current.total ?? 0), sub: comparison?.periodLabels.current ?? '-' },
                { label: 'Kỳ trước', value: formatValue(comparison?.previous.total ?? 0), sub: comparison?.periodLabels.previous ?? '-' },
                { label: 'Chênh lệch', value: formatDelta(comparison?.delta ?? 0), sub: comparison?.periodLabels.current ?? '-' },
                { label: 'Chênh lệch %', value: formatPct(comparison?.deltaPct ?? null), sub: comparison?.periodLabels.previous ?? '-' },
                { label: 'Tăng mạnh nhất', value: topGain ? topGain.label : '-', sub: topGain ? formatDelta(topGain.delta) : '-' },
                { label: 'Kéo giảm nhất', value: topDrag ? topDrag.label : '-', sub: topDrag ? formatDelta(topDrag.delta) : '-' },
                { label: 'Top CTG', value: topCtg ? topCtg.label : '-', sub: topCtg ? formatPointPct(topCtg.ctgPct) : '-' },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{item.label}</div>
                  <div className="mt-1 truncate text-lg font-bold text-slate-900 dark:text-white">{item.value}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">{item.sub}</div>
                </div>
              ))}
            </section>

            {/* Waterfall & Shift in Mix Grid */}
            <section className="grid gap-4 xl:grid-cols-12">
              {/* Thác nước biến động */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-7 dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">Thác nước biến động</h2>
                    <p className="text-xs text-slate-400">
                      {comparison?.periodLabels.current ?? '-'} so với {comparison?.periodLabels.previous ?? '-'}
                    </p>
                  </div>
                  <div className="text-right text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Tổng {formatDelta(comparison?.delta ?? 0)}
                  </div>
                </div>
                <div className="space-y-2">
                  {waterfallRows.map((row) => {
                    const delta = row.topDriver?.delta ?? 0;
                    const width = `${Math.max(6, (Math.abs(delta) / maxWaterfallDelta) * 100)}%`;
                    return (
                      <button
                        type="button"
                        key={row.value}
                        onClick={() => setDimension(row.value)}
                        className="grid min-h-11 w-full grid-cols-[92px_minmax(0,1fr)_90px] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{row.label}</span>
                        <span className="min-w-0">
                          <span className="mb-1 flex items-center justify-between text-xs">
                            <span className="truncate font-medium text-slate-900 dark:text-white">
                              {row.topDriver?.label ?? '-'}
                            </span>
                            <span className="text-slate-400">tổng {formatDelta(row.reconciledDelta)}</span>
                          </span>
                          <span className="block h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                            <span
                              className={`block h-2 rounded-full ${delta > 0 ? 'bg-emerald-500' : delta < 0 ? 'bg-rose-500' : 'bg-slate-400'}`}
                              style={{ width }}
                            />
                          </span>
                        </span>
                        <span className={`text-right text-sm font-bold ${delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {formatDelta(delta)}
                        </span>
                      </button>
                    );
                  })}
                  {waterfallRows.length === 0 && (
                    <div className="py-6 text-center text-xs text-slate-400">Không có dữ liệu thác nước</div>
                  )}
                </div>
              </div>

              {/* Dịch chuyển cơ cấu */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-5 dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Dịch chuyển cơ cấu</h2>
                  <span className="text-xs font-semibold text-slate-400">{dimensionLabel}</span>
                </div>
                <div className="space-y-3">
                  {topMixRows.length === 0 ? (
                    <div className="py-8 text-center text-xs text-slate-400">
                      Không có dữ liệu cơ cấu cho kỳ và bộ lọc hiện tại.
                    </div>
                  ) : (
                    topMixRows.map((driver) => (
                      <button
                        key={driver.key}
                        type="button"
                        onClick={() => setSelectedDriverKey(driver.key)}
                        className="min-h-11 w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                          <span className="truncate font-semibold text-slate-800 dark:text-slate-200">{driver.label}</span>
                          <span className="text-slate-400">{formatPointPct(driver.shareShift)}</span>
                        </div>
                        <div className="grid gap-1">
                          <div className="flex items-center gap-2">
                            <span className="w-8 text-[10px] font-semibold text-slate-400">Trước</span>
                            <span className="h-1.5 flex-1 rounded-full bg-slate-100 dark:bg-slate-800">
                              <span
                                className="block h-1.5 rounded-full bg-slate-400"
                                style={{ width: `${(driver.previousShare / maxMixShare) * 100}%` }}
                              />
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="w-8 text-[10px] font-semibold text-slate-400">Hiện</span>
                            <span className="h-1.5 flex-1 rounded-full bg-slate-100 dark:bg-slate-800">
                              <span
                                className="block h-1.5 rounded-full bg-primary"
                                style={{ width: `${(driver.currentShare / maxMixShare) * 100}%` }}
                              />
                            </span>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </section>

            {/* Xếp hạng CTG */}
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Xếp hạng CTG</h2>
                  <p className="text-xs text-slate-400">Hiện tại, kỳ trước, chênh lệch, CTG và dịch chuyển cơ cấu</p>
                </div>
                <div className="flex flex-wrap gap-1 print:hidden" aria-label="Nhóm tác nhân">
                  {DRIVER_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setDimension(tab.value)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                        dimension === tab.value
                          ? 'border-primary bg-primary text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[15px]">{tab.icon}</span>
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[380px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 print:max-h-none print:overflow-visible">
                <table className="min-w-[800px] w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-500 shadow-xs dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Tác nhân</th>
                      <th className="px-3 py-2 text-right">Kỳ trước</th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-slate-800 dark:hover:text-slate-200"
                        onClick={() => handleDriverSortClick('current')}
                        aria-sort={driverSortField === 'current' ? (driverSortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}
                      >
                        Hiện tại
                        <span className="ml-1 inline-block text-[10px] text-slate-400">
                          {driverSortField === 'current' ? (driverSortDirection === 'desc' ? '↓' : '↑') : '↕'}
                        </span>
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-slate-800 dark:hover:text-slate-200"
                        onClick={() => handleDriverSortClick('delta')}
                        aria-sort={driverSortField === 'delta' ? (driverSortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}
                      >
                        Chênh lệch
                        <span className="ml-1 inline-block text-[10px] text-slate-400">
                          {driverSortField === 'delta' ? (driverSortDirection === 'desc' ? '↓' : '↑') : '↕'}
                        </span>
                      </th>
                      <th className="px-3 py-2 text-right">Chênh lệch %</th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-slate-800 dark:hover:text-slate-200"
                        onClick={() => handleDriverSortClick('ctg')}
                        aria-sort={driverSortField === 'ctg' ? (driverSortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}
                      >
                        CTG
                        <span className="ml-1 inline-block text-[10px] text-slate-400">
                          {driverSortField === 'ctg' ? (driverSortDirection === 'desc' ? '↓' : '↑') : '↕'}
                        </span>
                      </th>
                      <th className="px-3 py-2 text-right">Δ cơ cấu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {displayedDrivers.map((driver) => (
                      <tr
                        key={driver.key}
                        onClick={() => setSelectedDriverKey(driver.key)}
                        className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                          selectedDriver?.key === driver.key ? 'bg-primary/5 font-semibold dark:bg-primary/10' : ''
                        }`}
                      >
                        <td className="max-w-[180px] truncate px-3 py-2 font-medium text-slate-900 dark:text-white">
                          {driver.label}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">
                          {formatValue(driver.previousValue)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">
                          {formatValue(driver.currentValue)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-bold ${
                            driver.delta > 0 ? 'text-emerald-600' : driver.delta < 0 ? 'text-rose-600' : 'text-slate-500'
                          }`}
                        >
                          {formatDelta(driver.delta)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500">{formatPct(driver.deltaPct)}</td>
                        <td className="px-3 py-2 text-right text-slate-500">{formatPointPct(driver.ctgPct)}</td>
                        <td className="px-3 py-2 text-right text-slate-500">{formatPointPct(driver.shareShift)}</td>
                      </tr>
                    ))}
                    {sortedDrivers.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                          Không có dòng xếp hạng cho kỳ đã chọn.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {sortedDrivers.length > 15 && (
                  <div className="flex justify-center border-t border-slate-100 p-2 dark:border-slate-800 print:hidden">
                    <button
                      type="button"
                      onClick={() => setShowAllDrivers((prev) => !prev)}
                      className="text-xs font-semibold text-primary hover:underline dark:text-primary-light"
                    >
                      {showAllDrivers ? 'Thu gọn' : `Xem tất cả (${sortedDrivers.length})`}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* Monthly Trend & Daily Trend Bars */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Xu hướng chuyến bay theo tháng */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Xu hướng theo tháng</h2>
                  <span className="text-xs text-slate-400">{comparisonTrendMetricLabel}</span>
                </div>
                <div className="overflow-x-auto pb-1">
                  <div className="flex h-44 min-w-[360px] items-end gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
                    {comparisonMonthlyTrendRows.map((row) => {
                      const isSelected = row.key === activeComparisonTrendMonth;
                      return (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() => setComparisonTrendMonth(row.key)}
                          className={`group flex h-full flex-1 flex-col items-center justify-end ${
                            isSelected ? 'bg-primary/5 rounded' : ''
                          }`}
                          title={`${row.label}: ${formatValue(row.value)} ${comparisonTrendMetricLabel}`}
                        >
                          <div
                            style={{ height: trendBarHeight(row.value, comparisonMaxMonthlyTrend) }}
                            className={`w-full rounded-t transition ${
                              isSelected
                                ? 'bg-primary'
                                : 'bg-slate-300 group-hover:bg-slate-400 dark:bg-slate-700 dark:group-hover:bg-slate-600'
                            }`}
                          />
                          <span className="mt-1 text-[10px] font-semibold text-slate-500">{row.key.slice(5)}</span>
                        </button>
                      );
                    })}
                    {comparisonMonthlyTrendRows.length === 0 && (
                      <div className="flex flex-1 items-center justify-center text-xs text-slate-400">
                        Chưa có dữ liệu xu hướng tháng.
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 text-right text-[11px] text-slate-400">
                  Tháng đang chọn: <span className="font-bold text-slate-700 dark:text-slate-200">{activeComparisonTrendMonth || '-'}</span>
                </div>
              </div>

              {/* Xu hướng chuyến bay theo ngày trong tháng */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                    Chi tiết từng ngày ({periodLabel(activeComparisonTrendMonth, 'mom')})
                  </h2>
                  <span className="text-xs text-slate-400">{comparisonTrendMetricLabel}</span>
                </div>
                <div className="overflow-x-auto pb-1">
                  <div className="flex h-44 min-w-[500px] items-end gap-1 border-b border-slate-200 pb-2 dark:border-slate-700">
                    {comparisonDailyTrendRows.map((row) => (
                      <div
                        key={row.key}
                        className="flex h-full flex-1 flex-col items-center justify-end"
                        title={`${row.key}: ${formatValue(row.value)} ${comparisonTrendMetricLabel}`}
                      >
                        <div
                          style={{ height: trendBarHeight(row.value, comparisonMaxDailyTrend) }}
                          className="w-full rounded-t bg-primary/75 hover:bg-primary transition"
                        />
                        <span className="mt-1 text-[9px] text-slate-400">{row.day ?? row.key.slice(8, 10)}</span>
                      </div>
                    ))}
                    {comparisonDailyTrendRows.length === 0 && (
                      <div className="flex flex-1 items-center justify-center text-xs text-slate-400">
                        Không có dữ liệu ngày cho tháng được chọn.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Drilldown tác nhân đã chọn */}
            {selectedDriver && (
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                      Chi tiết tác nhân: {selectedDriver.label}
                    </h2>
                    <p className="text-xs text-slate-400">
                      Chênh lệch {formatDelta(selectedDriver.delta)} ({formatPct(selectedDriver.deltaPct)}), Dịch chuyển cơ cấu {formatPointPct(selectedDriver.shareShift)}
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {dimensionLabel}
                  </span>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  {/* Daily breakdown of selected driver */}
                  <div className="lg:col-span-1">
                    <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Theo ngày vận hành</h3>
                    <div className="max-h-[300px] overflow-auto rounded-lg border border-slate-200 text-xs dark:border-slate-800 print:max-h-none print:overflow-visible">
                      <table className="w-full border-collapse">
                        <thead className="sticky top-0 bg-slate-100 text-[10px] font-bold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          <tr>
                            <th className="px-2 py-1.5 text-left">Ngày</th>
                            <th className="px-2 py-1.5 text-right">Chuyến</th>
                            <th className="px-2 py-1.5 text-right">Đến</th>
                            <th className="px-2 py-1.5 text-right">Đi</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {selectedDriverDrilldownRows.map((d) => (
                            <tr key={d.date} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                              <td className="px-2 py-1 font-medium">{d.date}</td>
                              <td className="px-2 py-1 text-right font-bold">{d.flights}</td>
                              <td className="px-2 py-1 text-right text-slate-500">{d.arrivals}</td>
                              <td className="px-2 py-1 text-right text-slate-500">{d.departures}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Individual flight records for selected driver */}
                  <div className="lg:col-span-2">
                    <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                      Danh sách chuyến bay ({selectedDriverRecords.length} chuyến)
                    </h3>
                    <div className="max-h-[300px] overflow-auto rounded-lg border border-slate-200 text-xs dark:border-slate-800 print:max-h-none print:overflow-visible">
                      <table className="min-w-[500px] w-full border-collapse">
                        <thead className="sticky top-0 bg-slate-100 text-[10px] font-bold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          <tr>
                            <th className="px-2 py-1.5 text-left">Ngày</th>
                            <th className="px-2 py-1.5 text-left">Chuyến</th>
                            <th className="px-2 py-1.5 text-left">Loại</th>
                            <th className="px-2 py-1.5 text-left">Tuyến</th>
                            <th className="px-2 py-1.5 text-left">Giờ</th>
                            <th className="px-2 py-1.5 text-left">Tàu bay</th>
                            <th className="px-2 py-1.5 text-right">Khách</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {displayedSelectedRecords.map((r, i) => (
                            <tr key={`${r.id}-${i}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                              <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{r.date}</td>
                              <td className="px-2 py-1 font-bold text-slate-900 dark:text-white">{r.flightNumber}</td>
                              <td className="px-2 py-1">{r.type === 'A' ? 'Đến' : 'Đi'}</td>
                              <td className="px-2 py-1 text-slate-600 dark:text-slate-400">{r.route}</td>
                              <td className="px-2 py-1">{r.schedule}</td>
                              <td className="px-2 py-1 text-slate-500">{r.aircraft}</td>
                              <td className="px-2 py-1 text-right font-medium">{r.pax || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selectedDriverRecords.length > 100 && (
                      <div className="flex justify-center border-t border-slate-100 p-2 dark:border-slate-800 print:hidden">
                        <button
                          type="button"
                          onClick={() => setShowAllRecords((prev) => !prev)}
                          className="text-xs font-semibold text-primary hover:underline dark:text-primary-light"
                        >
                          {showAllRecords ? 'Thu gọn' : `Xem tất cả (${selectedDriverRecords.length})`}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-surface text-on-surface">
          Đang tải dữ liệu báo cáo...
        </div>
      }
    >
      <ReportsContent />
    </Suspense>
  );
}
