'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@/lib/cn';
import {
  buildTimelineUrl,
  type NormalizedTrafficReportFilter,
  type TrafficReportBundle,
  type TrafficTimelinePoint,
  type TrafficType,
} from '@/lib/trafficReportContract';
import {
  fetchTrafficReportV2MonthlyTimeline,
  fetchTrafficReportV2TimelinePage,
  TrafficReportVersionChangedError,
} from '@/lib/trafficReportDataAdapter';
import type { TrafficV2ApiMonthlyTimelinePoint } from '@/lib/trafficReportV2Contract';
import { countCalendarMonths, shouldUseMonthlyTrend } from '@/lib/trafficReportTrendGranularity';
import { formatUiError } from '@/lib/uiDisplayText';
import { TrafficTrendTable } from './TrafficTrendTable';

const numberFormat = new Intl.NumberFormat('vi-VN');
const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const tooltipDateFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const monthFormat = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' });

const scopeLabels: Record<TrafficType, string> = {
  all: 'Cả hai',
  A: 'Chuyến bay đến',
  D: 'Chuyến bay đi',
};

function formatNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? numberFormat.format(value as number) : '—';
}
function formatDate(value: string): string {
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function formatMonth(value: string): string {
  return monthFormat.format(new Date(`${value}-15T12:00:00+07:00`));
}

function periodStatus(month: string, rows: TrafficTimelinePoint[]): 'complete' | 'partial' {
  const [yearValue, monthValue] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate();
  const coversFullMonth = rows.length === lastDay
    && rows[0]?.ops_date === `${month}-01`
    && rows.at(-1)?.ops_date === `${month}-${String(lastDay).padStart(2, '0')}`;
  return coversFullMonth ? 'complete' : 'partial';
}

function groupDailyTimelineByMonth(rows: TrafficTimelinePoint[]): TrafficV2ApiMonthlyTimelinePoint[] {
  const months = [...new Set(rows.map((row) => row.ops_date.slice(0, 7)))].sort();
  return months.map((month) => {
    const monthRows = rows.filter((row) => row.ops_date.startsWith(`${month}-`));
    const sum = (field: 'flights' | 'arrivals' | 'departures' | 'reported_pax' | 'reported_legs' | 'due_legs') => {
      const values = monthRows.flatMap((row) => typeof row[field] === 'number' ? [Number(row[field])] : []);
      return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
    };
    const completeDayCount = monthRows.filter((row) => row.completeness === 'complete').length;
    const partialDayCount = monthRows.filter((row) => row.completeness === 'partial').length;
    const missingDayCount = monthRows.filter((row) => row.completeness === 'missing').length;
    const flights = sum('flights');
    return {
      month,
      from: monthRows[0].ops_date,
      to: monthRows.at(-1)?.ops_date ?? monthRows[0].ops_date,
      selected_day_count: monthRows.length,
      complete_day_count: completeDayCount,
      partial_day_count: partialDayCount,
      missing_day_count: missingDayCount,
      flights,
      arrivals: sum('arrivals'),
      departures: sum('departures'),
      reported_pax: sum('reported_pax'),
      reported_legs: sum('reported_legs') ?? 0,
      due_legs: sum('due_legs') ?? 0,
      missing_due_legs: 0,
      true_zero_reported_legs: 0,
      period_status: periodStatus(month, monthRows),
      status: flights == null ? 'missing' : partialDayCount > 0 || missingDayCount > 0 ? 'partial' : flights === 0 ? 'zero' : 'complete',
    };
  });
}

interface TrendChartPoint {
  key: string;
  label: string;
  flights: number | null;
  reported_pax: number | null;
  unavailable: boolean;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function TrafficReportTrend({ filter, scope, readVersion = 'v1', expectedWatermark, readVersionToken, comparison, comparisonLabel, onScopeChange, onVersionChanged }: {
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  readVersion?: 'v1' | 'v2';
  expectedWatermark?: number;
  readVersionToken?: string;
  comparison?: TrafficReportBundle['kpis']['comparison'] | null;
  comparisonLabel?: string;
  onScopeChange: (scope: TrafficType) => void;
  onVersionChanged?: () => void;
}) {
  const [rows, setRows] = useState<TrafficTimelinePoint[]>([]);
  const [monthlyRows, setMonthlyRows] = useState<TrafficV2ApiMonthlyTimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const defaultMonthly = shouldUseMonthlyTrend(filter.from, filter.to);
  const [granularity, setGranularity] = useState<'auto' | 'daily' | 'monthly'>('auto');
  const monthlyMode = granularity === 'auto' ? defaultMonthly : granularity === 'monthly';

  const closeInteractions = useCallback(() => {
    setPointerIndex(null);
    setKeyboardIndex(null);
  }, []);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    closeInteractions();
    setLoading(true);
    setError(null);
    try {
      const loadDaily = async () => {
        const collected = new Map<string, TrafficTimelinePoint>();
        let after: string | null = null;
        let hasMore = true;
        let requestCount = 0;
        while (hasMore && requestCount < 50) {
          let timeline: TrafficTimelinePoint[];
          let nextCursor: string | null;
          if (readVersion === 'v2') {
            if (expectedWatermark === undefined || !readVersionToken) throw new Error('Dữ liệu xu hướng chưa sẵn sàng.');
            const payload = await fetchTrafficReportV2TimelinePage(filter, scope, after, expectedWatermark, readVersionToken, { signal: controller.signal });
            timeline = payload.timeline;
            hasMore = payload.hasMore;
            nextCursor = payload.nextCursor;
          } else {
            const response = await fetch(buildTimelineUrl(filter, scope, after), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
            const payload = await readJson(response) as { error?: unknown; timeline?: TrafficTimelinePoint[]; metadata?: { timeline_has_more?: boolean; timeline_next_cursor?: string | null } } | null;
            if (!response.ok) throw new Error('Không thể tải xu hướng. Vui lòng thử lại.');
            if (!payload || !Array.isArray(payload.timeline) || !payload.metadata) throw new Error('Dữ liệu xu hướng chưa sẵn sàng.');
            timeline = payload.timeline;
            hasMore = Boolean(payload.metadata.timeline_has_more);
            nextCursor = payload.metadata.timeline_next_cursor ?? null;
          }
          for (const row of timeline) collected.set(row.ops_date, row);
          if (hasMore && (!nextCursor || nextCursor === after)) throw new Error('Không thể hoàn tất dãy ngày đã chọn.');
          after = nextCursor;
          requestCount += 1;
        }
        if (hasMore) throw new Error('Dãy ngày quá lớn để tải trong một lần.');
        return [...collected.values()].sort((left, right) => left.ops_date.localeCompare(right.ops_date));
      };

      if (readVersion === 'v2') {
        if (expectedWatermark === undefined || !readVersionToken) throw new Error('Dữ liệu xu hướng chưa sẵn sàng.');
        const [months, daily] = await Promise.all([
          fetchTrafficReportV2MonthlyTimeline(filter, scope, expectedWatermark, readVersionToken, { signal: controller.signal }),
          monthlyMode ? Promise.resolve([] as TrafficTimelinePoint[]) : loadDaily(),
        ]);
        if (!controller.signal.aborted) { setMonthlyRows(months); setRows(daily); }
      } else {
        const daily = await loadDaily();
        if (!controller.signal.aborted) { setRows(daily); setMonthlyRows(groupDailyTimelineByMonth(daily)); }
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setError(formatUiError(reason, 'Không thể tải xu hướng.'));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [closeInteractions, expectedWatermark, filter, monthlyMode, onVersionChanged, readVersion, readVersionToken, scope]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
  }, [load]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !chartRef.current?.contains(target)) setPointerIndex(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, []);

  const chartRows = useMemo<TrendChartPoint[]>(() => monthlyMode
    ? monthlyRows.map((row) => ({
      key: row.month,
      label: formatMonth(row.month),
      flights: row.flights,
      reported_pax: row.reported_pax,
      unavailable: row.status === 'missing',
    }))
    : rows.map((row) => ({
      key: row.ops_date,
      label: formatDate(row.ops_date),
      flights: row.flights,
      reported_pax: row.reported_pax,
      unavailable: row.completeness === 'missing',
    })), [monthlyMode, monthlyRows, rows]);

  const chart = useMemo(() => {
    const width = 960;
    const height = 340;
    const top = 40;
    const bottom = 56;
    const left = 72;
    const right = 96;
    const plotHeight = height - top - bottom;
    const plotWidth = width - left - right;
    const flightValues = chartRows.flatMap((row) => row.flights == null || row.unavailable ? [] : [row.flights]);
    const paxValues = chartRows.flatMap((row) => row.reported_pax == null ? [] : [row.reported_pax]);
    const validFlightRows = chartRows.filter((row) => row.flights != null && !row.unavailable);
    const comparisonAvailable = comparison?.status === 'complete' && Boolean(comparison.from) && Boolean(comparison.to);
    const comparisonFlights = comparisonAvailable
      ? scope === 'A'
        ? comparison.arrivals
        : scope === 'D'
          ? comparison.departures
          : comparison.flights
      : null;
    const refFlight = comparisonAvailable && comparisonFlights != null && comparison.from && comparison.to
      ? monthlyMode
        ? (() => {
            const months = countCalendarMonths(comparison.from, comparison.to);
            return months > 0 ? comparisonFlights / months : null;
          })()
        : (() => {
            const days = Math.max(1, Math.round((new Date(`${comparison.to}T00:00:00Z`).getTime() - new Date(`${comparison.from}T00:00:00Z`).getTime()) / (24 * 60 * 60 * 1000)) + 1);
            return comparisonFlights / days;
          })()
      : null;
    const refLabel = refFlight != null
      ? monthlyMode
        ? `TB tháng đối chiếu (${comparisonLabel ?? 'kỳ trước'}): ${numberFormat.format(Math.round(refFlight))} chuyến/tháng`
        : `TB ngày đối chiếu (${comparisonLabel ?? 'kỳ trước'}): ${numberFormat.format(Math.round(refFlight))} chuyến/ngày`
      : null;
    const maxFlights = flightValues.length > 0 ? Math.max(...flightValues) : null;
    const maxPax = paxValues.length > 0 ? Math.max(...paxValues) : null;
    const flightScaleMax = Math.max(1, maxFlights ?? 0, refFlight != null ? Math.ceil(refFlight * 1.05) : 0);
    const paxScaleMax = Math.max(1, maxPax ?? 0);
    const slotWidth = plotWidth / Math.max(1, chartRows.length);
    const barWidth = Math.max(1.5, Math.min(18, slotWidth * 0.72));
    const x = (index: number) => left + (index + 0.5) * slotWidth;
    const flightY = (value: number) => top + plotHeight - (value / flightScaleMax) * plotHeight;
    const paxY = (value: number) => top + plotHeight - (value / paxScaleMax) * plotHeight;
    const buildSeries = (
      key: 'flights' | 'reported_pax',
      y: (value: number) => number,
      isAvailable: (row: TrendChartPoint) => boolean,
    ) => {
      const segments: string[] = [];
      const singletons: Array<{ index: number; x: number; y: number }> = [];
      let current: Array<{ index: number; x: number; y: number }> = [];
      const flush = () => {
        if (current.length > 1) segments.push(current.map((point) => `${point.x},${point.y}`).join(' '));
        if (current.length === 1) singletons.push(current[0]);
        current = [];
      };
      chartRows.forEach((row, index) => {
        const value = row[key];
        if (value == null || !isAvailable(row)) {
          flush();
        } else {
          current.push({ index, x: x(index), y: y(value) });
        }
      });
      flush();
      return { segments, singletons };
    };
    const paxSeries = buildSeries('reported_pax', paxY, () => true);
    const monthBoundaryIndexes = chartRows.flatMap((row, i) => i > 0 && row.key.slice(0, 7) !== chartRows[i - 1].key.slice(0, 7) ? [i] : []);
    const xTickIndexes = monthlyMode
      ? [...new Set([0, Math.floor((chartRows.length - 1) / 2), chartRows.length - 1])]
      : chartRows.length <= 14
        ? chartRows.map((_, i) => i)
        : [...new Set([0, ...monthBoundaryIndexes, chartRows.length - 1])];
    return {
      width,
      height,
      top,
      bottom,
      left,
      right,
      plotHeight,
      plotWidth,
      slotWidth,
      barWidth,
      maxFlights,
      maxPax,
      hasPax: maxPax != null,
      refFlight,
      refLabel,
      x,
      flightY,
      paxY,
      paxSeries,
      xTickIndexes,
    };
  }, [chartRows, comparison, comparisonLabel, monthlyMode, scope]);

  const activeIndex = pointerIndex ?? keyboardIndex;
  const activeRow = activeIndex == null ? null : chartRows[activeIndex] ?? null;
  const activeX = activeIndex == null ? 0 : chart.x(activeIndex);
  const activePosition = activeIndex == null || chartRows.length <= 1 ? 50 : (activeIndex / (chartRows.length - 1)) * 100;

  const monthDividers = useMemo(() => {
    if (monthlyMode) return [];
    const dividers: Array<{ index: number; label: string }> = [];
    chartRows.forEach((row, i) => {
      if (i > 0 && row.key.slice(0, 7) !== chartRows[i - 1].key.slice(0, 7)) {
        dividers.push({ index: i, label: `Tháng ${Number(row.key.slice(5, 7))}` });
      }
    });
    return dividers;
  }, [chartRows, monthlyMode]);
  const selectFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (chartRows.length === 0) return;
    const bounds = chartRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const chartX = ratio * chart.width;
    const plotRatio = Math.min(1, Math.max(0, (chartX - chart.left) / chart.plotWidth));
    setKeyboardIndex(null);
    setPointerIndex(Math.min(chartRows.length - 1, Math.floor(plotRatio * chartRows.length)));
  };

  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInteractions();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || chartRows.length === 0) return;
    event.preventDefault();
    setPointerIndex(null);
    setKeyboardIndex((current) => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return chartRows.length - 1;
      const start = current ?? chartRows.length - 1;
      return Math.min(chartRows.length - 1, Math.max(0, start + (event.key === 'ArrowLeft' ? -1 : 1)));
    });
  };

  const peakFlights = chartRows.filter((row) => row.flights != null).sort((left, right) => (right.flights ?? 0) - (left.flights ?? 0))[0];
  const peakPax = chartRows.filter((row) => row.reported_pax != null).sort((left, right) => (right.reported_pax ?? 0) - (left.reported_pax ?? 0))[0];

  return (
    <section aria-labelledby="trend-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-sm font-bold text-blue-900">Tổng quan sản lượng</p>
          <h2 id="trend-title" className="mt-1 text-balance text-2xl font-bold text-slate-950" title="Xu hướng chuyến bay và sản lượng khách">Xu hướng chuyến bay và sản lượng khách</h2>
          <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">Theo dõi tương quan giữa sản lượng chuyến bay và sản lượng khách trong cùng phạm vi. Sản lượng khách chỉ tính số khách đã báo cáo.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Độ phân giải thời gian</legend>
            {(['auto', 'daily', 'monthly'] as const).map((mode) => {
              const label = mode === 'auto' ? 'Tự động' : mode === 'daily' ? 'Theo ngày' : 'Theo tháng';
              const isActive = granularity === mode;
              return (
                <button
                  key={mode}
                  className={cn(
                    'report-focus min-h-11 rounded-lg border px-3 text-sm font-bold',
                    isActive ? 'border-blue-900 bg-blue-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-blue-700'
                  )}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setGranularity(mode)}
                >{label}</button>
              );
            })}
          </fieldset>
          <ScopeSelector value={scope} onChange={onScopeChange} label="Phạm vi của biểu đồ xu hướng" />
        </div>
      </div>

      {loading ? <div className="mt-6 space-y-3" role="status"><div className="h-64 animate-pulse rounded-xl bg-slate-100" /><div className="h-4 w-56 animate-pulse rounded bg-slate-100" /><span className="sr-only">Đang tải xu hướng</span></div> : null}
      {error ? <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert"><p className="font-semibold">Không thể tải xu hướng</p><p className="mt-1 text-sm">{error}</p><button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 text-sm font-bold text-white focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" type="button" onClick={() => void load()}>Thử lại</button></div> : null}
      {!loading && !error && chartRows.length === 0 ? <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5"><p className="font-semibold">Chưa có dữ liệu trong phạm vi này.</p><p className="mt-1 text-sm text-slate-600">Hãy chọn khoảng ngày hoặc bộ lọc khác.</p></div> : null}

      {!loading && !error && chartRows.length > 0 ? <>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{peakFlights?.flights != null ? `${monthlyMode ? 'Tháng' : 'Ngày'} nhiều chuyến nhất: ${peakFlights.label} với ${formatNumber(peakFlights.flights)} chuyến.` : `Chưa đủ dữ liệu để xác định ${monthlyMode ? 'tháng' : 'ngày'} nhiều chuyến nhất.`}</p>
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{peakPax?.reported_pax != null ? `${monthlyMode ? 'Tháng' : 'Ngày'} có sản lượng khách cao nhất: ${peakPax.label} với ${formatNumber(peakPax.reported_pax)} khách đã báo cáo.` : `Chưa có số liệu sản lượng khách để xác định ${monthlyMode ? 'tháng' : 'ngày'} cao nhất.`}</p>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs font-semibold text-slate-700">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-2"><span className="h-3 w-5 rounded-sm bg-blue-900" />Sản lượng chuyến bay</span>
            <span className="inline-flex items-center gap-2"><span className="h-0.5 w-7 bg-cyan-700" />Sản lượng khách</span>
            {chart.refFlight != null ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-0.5 w-6 border-b-2 border-dashed border-amber-500" />
                TB {monthlyMode ? 'tháng' : 'ngày'} đối chiếu ({comparisonLabel ?? 'kỳ trước'})
              </span>
            ) : null}
          </div>
          <span>{scopeLabels[scope]} · Theo {monthlyMode ? 'tháng' : 'ngày'}</span>
        </div>
        {!chart.hasPax ? <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" role="status">Chưa có số liệu sản lượng khách trong phạm vi này. Biểu đồ vẫn hiển thị sản lượng chuyến bay.</p> : null}
        <div className="mt-3 overflow-x-auto pb-2">
          <div
            ref={chartRef}
            className="report-focus relative min-w-[720px] cursor-crosshair rounded-lg focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2"
            role="group"
            tabIndex={0}
            aria-label={`Biểu đồ xu hướng ${scopeLabels[scope]} theo ${monthlyMode ? 'tháng' : 'ngày'}. Trục trái là chuyến bay${chart.hasPax ? ', trục phải là sản lượng khách' : '; chưa có số liệu sản lượng khách trong phạm vi này'}.`}
            aria-describedby={activeRow ? 'traffic-trend-tooltip' : undefined}
            onKeyDown={selectFromKeyboard}
            onBlur={closeInteractions}
            onPointerDown={selectFromPointer}
            onPointerMove={(event) => { if (event.pointerType !== 'touch') selectFromPointer(event); }}
            onPointerLeave={(event) => { if (event.pointerType !== 'touch') setPointerIndex(null); }}
            onPointerCancel={() => setPointerIndex(null)}
          >
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="w-full" aria-hidden="true">
              <text x={chart.left} y="18" fill="#1e3a8a" fontSize="13" fontWeight="700">Chuyến bay</text>
              <text x={chart.width - chart.right} y="18" fill="#0e7490" fontSize="13" fontWeight="700" textAnchor="end">{chart.hasPax ? 'Sản lượng khách' : 'Sản lượng khách · chưa có số liệu'}</text>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = chart.top + chart.plotHeight * ratio;
                const flightTick = chart.maxFlights == null ? null : Math.round(chart.maxFlights * (1 - ratio));
                const paxTick = chart.maxPax == null ? null : Math.round(chart.maxPax * (1 - ratio));
                return <g key={ratio}>
                  <line x1={chart.left} y1={y} x2={chart.width - chart.right} y2={y} stroke="#d7e0e8" />
                  {flightTick != null ? <text x={chart.left - 10} y={y + 4} fill="#475569" fontSize="11" textAnchor="end">{numberFormat.format(flightTick)}</text> : null}
                  {paxTick != null ? <text x={chart.width - chart.right + 10} y={y + 4} fill="#475569" fontSize="11">{numberFormat.format(paxTick)}</text> : null}
                </g>;
              })}
              {activeIndex != null ? (
                <rect
                  x={chart.x(activeIndex) - chart.slotWidth / 2}
                  y={chart.top}
                  width={chart.slotWidth}
                  height={chart.plotHeight}
                  fill="#0284c7"
                  fillOpacity="0.08"
                  pointerEvents="none"
                />
              ) : null}
              {monthDividers.map((div) => {
                const divX = chart.x(div.index) - chart.slotWidth / 2;
                return (
                  <g key={`month-div-${div.index}`}>
                    <line x1={divX} y1={chart.top} x2={divX} y2={chart.height - chart.bottom} stroke="#94a3b8" strokeDasharray="3 3" strokeWidth="1" />
                    <text x={divX + 4} y={chart.top + 14} fill="#64748b" fontSize="10" fontWeight="600">{div.label}</text>
                  </g>
                );
              })}
              {chartRows.map((row, index) => {
                if (row.flights == null || row.unavailable) return null;
                const scaledY = chart.flightY(row.flights);
                const baseline = chart.height - chart.bottom;
                const barHeight = row.flights === 0 ? 1 : baseline - scaledY;
                return <rect
                  key={`flights-${row.key}`}
                  x={chart.x(index) - chart.barWidth / 2}
                  y={row.flights === 0 ? baseline - 1 : scaledY}
                  width={chart.barWidth}
                  height={barHeight}
                  rx="1.5"
                  fill="#1e3a8a"
                  fillOpacity="0.82"
                  stroke={activeIndex === index ? '#0f172a' : 'none'}
                  strokeWidth={activeIndex === index ? 2 : 0}
                />;
              })}
              {chart.refFlight != null ? (
                <g key="comparison-ref-line">
                  <line
                    x1={chart.left}
                    y1={chart.flightY(chart.refFlight)}
                    x2={chart.width - chart.right}
                    y2={chart.flightY(chart.refFlight)}
                    stroke="#f59e0b"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                    strokeOpacity="0.9"
                  />
                  <text
                    x={chart.width - chart.right - 6}
                    y={chart.flightY(chart.refFlight) - 5}
                    fill="#b45309"
                    stroke="#ffffff"
                    strokeWidth="3.5"
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    fontSize="10"
                    fontWeight="700"
                    textAnchor="end"
                  >
                    {chart.refLabel}
                  </text>
                </g>
              ) : null}
              {chart.paxSeries.segments.map((points, index) => <polyline key={`pax-${index}`} points={points} fill="none" stroke="#0e7490" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />)}
              {chart.paxSeries.singletons.map((point) => <circle key={`pax-singleton-${point.index}`} cx={point.x} cy={point.y} r="4" fill="white" stroke="#0891b2" strokeWidth="3" />)}
              {activeRow ? <>
                <line x1={activeX} y1={chart.top} x2={activeX} y2={chart.height - chart.bottom} stroke="#0f172a" strokeWidth="1.5" strokeDasharray="4 5" />
                {activeRow.reported_pax != null ? <circle cx={activeX} cy={chart.paxY(activeRow.reported_pax)} r="5" fill="white" stroke="#0891b2" strokeWidth="3" /> : null}
              </> : null}
              {chart.xTickIndexes.map((index) => <text
                key={`x-tick-${index}`}
                x={chart.x(index)}
                y={chart.height - 16}
                fill="#475569"
                fontSize="11"
                textAnchor={index === 0 ? 'start' : index === chartRows.length - 1 ? 'end' : 'middle'}
              >{chartRows[index].label}</text>)}
            </svg>
            {activeRow ? <div id="traffic-trend-tooltip" className="pointer-events-none absolute top-10 w-64 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg" style={{ left: `${Math.min(86, Math.max(14, activePosition))}%` }} role="tooltip">
              <p className="font-bold capitalize text-slate-950">{monthlyMode ? activeRow.label : tooltipDateFormat.format(new Date(`${activeRow.key}T12:00:00+07:00`))}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
                <dt>Chuyến bay</dt><dd className="text-right font-bold">{formatNumber(activeRow.flights)}</dd>
                <dt>Sản lượng khách</dt><dd className="text-right font-bold">{formatNumber(activeRow.reported_pax)}</dd>
                {chart.refFlight != null && activeRow.flights != null ? (
                  <div className="col-span-2 mt-1 border-t border-slate-100 pt-1 text-[11px] text-slate-600">
                    <dt className="inline">So với TB đối chiếu: </dt>
                    <dd className={cn('inline font-semibold', activeRow.flights >= chart.refFlight ? 'text-emerald-700' : 'text-rose-700')}>
                      {activeRow.flights >= chart.refFlight ? '+' : ''}{numberFormat.format(Math.round(activeRow.flights - chart.refFlight))} chuyến
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div> : null}
          </div>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">Di chuột, chạm hoặc dùng phím mũi tên để xem từng {monthlyMode ? 'tháng' : 'ngày'}. Chạm ra ngoài hoặc nhấn Escape để đóng. Khoảng đứt biểu thị kỳ chưa có số liệu sản lượng khách.</p>
        <p className="sr-only" aria-live="polite">{activeRow ? `${activeRow.label}: ${formatNumber(activeRow.flights)} chuyến, sản lượng khách ${formatNumber(activeRow.reported_pax)}.` : ''}</p>

        <TrafficTrendTable monthlyRows={monthlyRows} fallbackDailyRows={rows} filter={filter} scope={scope} readVersion={readVersion} expectedWatermark={expectedWatermark} readVersionToken={readVersionToken} onVersionChanged={onVersionChanged} />
      </> : null}
    </section>
  );
}

export function ScopeSelector({ value, onChange, label }: { value: TrafficType; onChange: (scope: TrafficType) => void; label: string }) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{label}</legend>
      {(['all', 'A', 'D'] as const).map((scope) => <button
        key={scope}
        className={cn('report-focus min-h-11 rounded-lg border px-3 text-sm font-bold focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2', value === scope ? 'border-blue-900 bg-blue-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-blue-700')}
        type="button"
        aria-pressed={value === scope}
        onClick={() => onChange(scope)}
      >{scopeLabels[scope]}</button>)}
    </fieldset>
  );
}
