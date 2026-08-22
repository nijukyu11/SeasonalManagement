'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  buildOverviewUrl,
  detectTrafficReportDatePreset,
  getLatestCompletedOpsDate,
  getTrafficReportPresetRange,
  isTrafficReportBundle,
  parseTrafficReportSearchParams,
  toTrafficReportSearchParams,
  type NormalizedTrafficReportFilter,
  type TrafficBreakdownRow,
  type TrafficDatePreset,
  type TrafficReportBundle,
  type TrafficReportFilter,
  type TrafficTimelinePoint,
} from '@/lib/trafficReportContract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const tooltipDateFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

function formatNumber(value: number | null): string {
  return value == null ? '—' : numberFormat.format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function formatTooltipDate(value: string): string {
  return tooltipDateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function comparisonDelta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function DeltaPill({ value, label }: { value: number | null; label: string }) {
  const tone = value == null ? 'bg-slate-100 text-slate-600' : value >= 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800';
  return (
    <span className={`inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold ${tone}`}>
      {value == null ? 'Không đủ dữ liệu' : `${value >= 0 ? '+' : ''}${percentFormat.format(value)}%`} · {label}
    </span>
  );
}

function KpiCard({ label, value, delta, comparisonLabel, note, suffix = '' }: { label: string; value: number | null; delta: number | null; comparisonLabel: string; note?: string; suffix?: string }) {
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-600">{label}</p>
      <p className="mt-3 text-3xl font-bold tracking-tight text-[#102033] tabular-nums">{formatNumber(value)}{value == null ? '' : suffix}</p>
      <div className="mt-4"><DeltaPill value={delta} label={comparisonLabel} /></div>
      {note ? <p className="mt-3 text-xs leading-5 text-slate-500">{note}</p> : null}
    </article>
  );
}

function TimelineChart({ rows, totalFlights, dayCount }: { rows: TrafficTimelinePoint[]; totalFlights: number | null; dayCount: number }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...rows.flatMap((row) => [row.flights ?? 0, row.arrivals ?? 0, row.departures ?? 0]));
  const width = 960;
  const height = 260;
  const segmentsFor = (metric: 'flights' | 'arrivals' | 'departures') => {
    const segments: string[] = [];
    let current: string[] = [];
    rows.forEach((row, index) => {
      const value = row[metric];
      if (value == null) {
        if (current.length > 1) segments.push(current.join(' '));
        current = [];
        return;
      }
      const x = rows.length <= 1 ? width / 2 : (index / (rows.length - 1)) * width;
      const y = height - (value / max) * (height - 30) - 15;
      current.push(`${x},${y}`);
    });
    if (current.length > 1) segments.push(current.join(' '));
    return segments;
  };
  const series = [
    { key: 'flights' as const, label: 'Tổng', color: '#234093', width: 4 },
    { key: 'arrivals' as const, label: 'ARR', color: '#00B4D8', width: 2.5 },
    { key: 'departures' as const, label: 'DEP', color: '#42C1C7', width: 2.5 },
  ];
  const averageFlights = totalFlights == null || dayCount <= 0 ? 0 : totalFlights / dayCount;
  const activeRow = activeIndex == null ? null : rows[activeIndex] ?? null;
  const activePosition = activeIndex == null || rows.length <= 1 ? 50 : (activeIndex / (rows.length - 1)) * 100;
  const activeX = (activePosition / 100) * width;
  const averageRatio = activeRow?.flights == null || averageFlights === 0 ? null : (activeRow.flights / averageFlights) * 100;

  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const bounds = chartRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setActiveIndex(Math.round(ratio * (rows.length - 1)));
  };

  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex((currentIndex) => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return rows.length - 1;
      const current = currentIndex ?? rows.length - 1;
      return Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowLeft' ? -1 : 1)));
    });
  };

  return (
    <div>
      <div className="overflow-x-auto pb-2">
        <div
          ref={chartRef}
          className="report-focus relative min-w-[720px] cursor-crosshair rounded-lg"
          role="group"
          tabIndex={0}
          aria-label="Biểu đồ sản lượng theo Ops Date. Dùng phím mũi tên trái hoặc phải để xem từng ngày."
          aria-describedby="timeline-chart-help"
          onFocus={() => setActiveIndex((currentIndex) => currentIndex ?? Math.max(0, rows.length - 1))}
          onKeyDown={selectFromKeyboard}
          onPointerDown={selectFromPointer}
          onPointerMove={(event) => { if (event.pointerType !== 'touch') selectFromPointer(event); }}
        >
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full" aria-hidden="true">
            {[0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} x1="0" y1={height * ratio - 1} x2={width} y2={height * ratio - 1} stroke="#d7e0e8" />)}
            {series.flatMap((item) => segmentsFor(item.key).map((points, index) => <polyline key={`${item.key}-${index}`} points={points} fill="none" stroke={item.color} strokeWidth={item.width} strokeLinejoin="round" strokeLinecap="round" />))}
            {activeRow ? <>
              <line x1={activeX} y1="0" x2={activeX} y2={height} stroke="#081322" strokeWidth="1.5" strokeDasharray="5 5" />
              {series.map((item) => {
                const value = activeRow[item.key];
                if (value == null) return null;
                const y = height - (value / max) * (height - 30) - 15;
                return <circle key={item.key} cx={activeX} cy={y} r={item.key === 'flights' ? 6 : 4.5} fill="white" stroke={item.color} strokeWidth="3" />;
              })}
            </> : null}
          </svg>
          {activeRow ? <div
            className="pointer-events-none absolute top-3 w-60 rounded-xl border border-slate-200 bg-white p-3 text-left text-xs text-slate-700 shadow-lg"
            style={{ left: `${Math.min(86, Math.max(14, activePosition))}%`, transform: 'translateX(-50%)' }}
            role="tooltip"
          >
            <p className="font-bold capitalize text-[#102033]">{formatTooltipDate(activeRow.ops_date)}</p>
            {activeRow.flights == null ? <p className="mt-2 font-semibold text-amber-800">Đã ẩn theo ngưỡng bảo vệ</p> : <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <dt>Tổng chuyến</dt><dd className="text-right font-bold">{formatNumber(activeRow.flights)}</dd>
              <dt>ARR</dt><dd className="text-right">{formatNumber(activeRow.arrivals)}</dd>
              <dt>DEP</dt><dd className="text-right">{formatNumber(activeRow.departures)}</dd>
              <dt>Pax báo cáo</dt><dd className="text-right">{formatNumber(activeRow.reported_pax)}</dd>
              <dt>So với TB ngày</dt><dd className="text-right">{averageRatio == null ? '—' : `${percentFormat.format(averageRatio)}%`}</dd>
            </dl>}
          </div> : null}
        </div>
      </div>
      <p id="timeline-chart-help" className="mt-2 text-xs text-slate-500">Di chuột, chạm vào biểu đồ hoặc dùng phím mũi tên để xem chi tiết từng Ops Date.</p>
      <p className="sr-only" aria-live="polite">{activeRow ? `${formatTooltipDate(activeRow.ops_date)}: ${activeRow.flights == null ? 'đã ẩn theo ngưỡng bảo vệ' : `${formatNumber(activeRow.flights)} chuyến, ARR ${formatNumber(activeRow.arrivals)}, DEP ${formatNumber(activeRow.departures)}`}` : ''}</p>
      <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold text-slate-600">{series.map((item) => <span key={item.key} className="inline-flex items-center gap-2"><span className="h-0.5 w-6" style={{ backgroundColor: item.color }} />{item.label}</span>)}</div>
      <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-[#234093]">Bảng dữ liệu biểu đồ</summary>
        <div className="mt-4 max-h-80 overflow-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead><tr className="border-b border-slate-300"><th className="p-2">Ops Date</th><th className="p-2 text-right">Tổng</th><th className="p-2 text-right">ARR</th><th className="p-2 text-right">DEP</th><th className="p-2">Trạng thái</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.ops_date} className="border-b border-slate-200"><td className="p-2">{formatDate(row.ops_date)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.flights)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.arrivals)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.departures)}</td><td className="p-2">{row.completeness}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function BreakdownTable({ title, rows, showShareBars = false }: { title: string; rows: TrafficBreakdownRow[]; showShareBars?: boolean }) {
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-lg font-bold text-[#102033]">{title}</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead><tr className="border-b border-slate-300 text-left text-slate-500"><th className="py-2">Nhóm</th><th className="py-2 text-right">Chuyến</th>{showShareBars ? null : <th className="py-2 text-right">Tỷ trọng</th>}</tr></thead>
          <tbody>{rows.map((row) => {
            const sharePercent = row.share == null ? null : Math.min(100, Math.max(0, row.share * 100));
            return <tr key={row.key} className="border-b border-slate-100">
              <td className="py-3 pr-4 font-medium">
                <span>{row.label}</span>
                {showShareBars ? <div className="mt-2 flex items-center gap-2">
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100" role={sharePercent == null ? undefined : 'progressbar'} aria-label={sharePercent == null ? undefined : `Tỷ trọng ${row.label}`} aria-valuemin={sharePercent == null ? undefined : 0} aria-valuemax={sharePercent == null ? undefined : 100} aria-valuenow={sharePercent == null ? undefined : Number(sharePercent.toFixed(1))}>
                    <span className="block h-full rounded-full bg-[#00b4d8]" style={{ width: `${sharePercent ?? 0}%` }} />
                  </span>
                  <span className="w-12 text-right text-xs font-semibold tabular-nums text-slate-600">{sharePercent == null ? '—' : `${percentFormat.format(sharePercent)}%`}</span>
                </div> : null}
              </td>
              <td className="py-3 text-right tabular-nums">{row.suppressed ? 'Đã ẩn' : formatNumber(row.flights)}</td>
              {showShareBars ? null : <td className="py-3 text-right tabular-nums">{row.share == null ? '—' : `${percentFormat.format(row.share * 100)}%`}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    </article>
  );
}

function buildInsights(bundle: TrafficReportBundle): string[] {
  const current = bundle.kpis.current;
  const comparison = bundle.kpis.comparison;
  const coverage = bundle.kpis.pax_coverage;
  const topAirline = bundle.breakdowns.airline.find((row) => !row.suppressed && row.label !== 'Khác');
  const insights = [
    bundle.kpis.peak_day.ops_date && bundle.kpis.peak_day.flights != null
      ? `Ngày cao điểm là ${formatDate(bundle.kpis.peak_day.ops_date)} với ${formatNumber(bundle.kpis.peak_day.flights)} chuyến.`
      : 'Chưa đủ dữ liệu để xác định ngày cao điểm.',
    topAirline?.flights != null
      ? `${topAirline.label} dẫn đầu theo sản lượng với ${formatNumber(topAirline.flights)} chuyến.`
      : 'Cơ cấu hãng bay đang được ẩn do ngưỡng bảo vệ dữ liệu nhỏ.',
    coverage.percent != null
      ? `Pax coverage đạt ${percentFormat.format(coverage.percent)}% (${formatNumber(coverage.reported_legs)}/${formatNumber(coverage.due_legs)} leg đến hạn).`
      : 'Pax coverage chưa đủ cohort để công bố.',
  ];
  const delta = comparisonDelta(current.flights, comparison.flights);
  insights.push(delta == null ? 'Kỳ so sánh không khả dụng hoặc chưa đủ dữ liệu.' : `Sản lượng ${delta >= 0 ? 'tăng' : 'giảm'} ${percentFormat.format(Math.abs(delta))}% so với kỳ đối chiếu.`);
  return insights;
}

export default function TrafficReportClient() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [bundle, setBundle] = useState<TrafficReportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const lastSuccessfulQueryRef = useRef<string | null>(null);
  const parsed = useMemo(() => {
    try { return { filter: parseTrafficReportSearchParams(new URLSearchParams(searchParams.toString())), error: null }; }
    catch (reason) { return { filter: null, error: reason instanceof Error ? reason.message : 'Bộ lọc không hợp lệ.' }; }
  }, [searchParams]);

  const load = useCallback(async (filter: TrafficReportFilter) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(buildOverviewUrl(filter), {
        method: 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (!isTrafficReportBundle(payload)) throw new Error('Phản hồi báo cáo không đúng contract.');
      setBundle(payload);
      const currentCanonical = toTrafficReportSearchParams(payload.metadata.normalized_filter).toString();
      lastSuccessfulQueryRef.current = currentCanonical;
      if (currentCanonical !== searchParams.toString()) window.history.replaceState(null, '', `${pathname}?${currentCanonical}`);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Không thể tải báo cáo.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [pathname, searchParams]);

  useEffect(() => {
    const canonical = parsed.filter ? toTrafficReportSearchParams(parsed.filter).toString() : null;
    if (parsed.filter && lastSuccessfulQueryRef.current !== canonical) void load(parsed.filter);
    else { setError(parsed.error); setLoading(false); }
    return () => controllerRef.current?.abort();
  }, [load, parsed]);

  const loadMoreTimeline = async () => {
    if (!bundle?.metadata.timeline_next_cursor || loadingMore) return;
    const query = toTrafficReportSearchParams(bundle.metadata.normalized_filter);
    query.set('after', bundle.metadata.timeline_next_cursor);
    query.set('page_size', '366');
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/report/v1/timeline?${query.toString()}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== 'object') throw new Error(`Không thể tải trang timeline tiếp theo (${response.status}).`);
      const page = payload as { timeline?: TrafficTimelinePoint[]; metadata?: Pick<TrafficReportBundle['metadata'], 'timeline_has_more' | 'timeline_next_cursor'> };
      if (!Array.isArray(page.timeline) || !page.metadata) throw new Error('Trang timeline không đúng contract.');
      setBundle((currentBundle) => {
        if (!currentBundle) return currentBundle;
        const rows = new Map(currentBundle.timeline.map((row) => [row.ops_date, row]));
        for (const row of page.timeline ?? []) rows.set(row.ops_date, row);
        return { ...currentBundle, timeline: [...rows.values()].sort((left, right) => left.ops_date.localeCompare(right.ops_date)), metadata: { ...currentBundle.metadata, ...page.metadata } };
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không thể tải trang timeline tiếp theo.');
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilter = (formData: FormData) => {
    const split = (key: string) => String(formData.get(key) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const next: NormalizedTrafficReportFilter = {
      from: String(formData.get('from')),
      to: String(formData.get('to')),
      type: String(formData.get('type')) as NormalizedTrafficReportFilter['type'],
      airline: split('airline'),
      route: split('route'),
      country: split('country'),
      comp: String(formData.get('comp')) as NormalizedTrafficReportFilter['comp'],
      tz: String(formData.get('tz')) as NormalizedTrafficReportFilter['tz'],
    };
    window.history.pushState(null, '', `${pathname}?${toTrafficReportSearchParams(next).toString()}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const applyDatePreset = (preset: TrafficDatePreset) => {
    if (!bundle) return;
    const presetAnchor = getLatestCompletedOpsDate(bundle.data_as_of, bundle.metadata.max_ops_date);
    const range = getTrafficReportPresetRange(preset, bundle.metadata.min_ops_date, presetAnchor);
    const next: NormalizedTrafficReportFilter = { ...bundle.metadata.normalized_filter, ...range };
    window.history.pushState(null, '', `${pathname}?${toTrafficReportSearchParams(next).toString()}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const current = bundle?.kpis.current;
  const comparison = bundle?.kpis.comparison;
  const comparisonLabel = comparison?.mode === 'year_ago' ? 'cùng kỳ năm trước' : 'kỳ trước liền kề';
  const insights = bundle ? buildInsights(bundle) : [];
  const filter = bundle?.metadata.normalized_filter ?? parsed.filter;
  const presetAnchor = bundle ? getLatestCompletedOpsDate(bundle.data_as_of, bundle.metadata.max_ops_date) : null;
  const activeDatePreset = bundle && presetAnchor && filter?.from && filter.to
    ? detectTrafficReportDatePreset(filter.from, filter.to, bundle.metadata.min_ops_date, presetAnchor)
    : null;

  return (
    <>
      <section className="relative overflow-hidden bg-[#081322] text-white">
        <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_center,#234093_0%,transparent_68%)] opacity-60" />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1.2fr_0.8fr] lg:py-24">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#42c1c7]">State of Airport Operations</p>
            <h1 className="report-headline mt-5 max-w-4xl font-bold">Dòng chảy khai thác, nhìn theo từng Ops Date.</h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-slate-300">Một dãy ngày liên tục, không phụ thuộc mùa. Sản lượng phản ánh lịch hiệu lực mới nhất; Pax chỉ cộng số đã báo cáo và luôn đi kèm coverage.</p>
          </div>
          <div className="self-end border-l border-white/20 pl-6">
            <p className="text-sm text-slate-300">Tổng chuyến trong kỳ</p>
            <p className="report-display mt-3 font-bold text-[#00b4d8] tabular-nums">{formatNumber(current?.flights ?? null)}</p>
            <p className="mt-4 text-sm text-slate-300">{filter?.from && filter?.to ? `${formatDate(filter.from)} — ${formatDate(filter.to)}` : 'Đang xác định phạm vi dữ liệu'}</p>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#234093]">Executive summary</p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">{insights.map((insight, index) => <p key={insight} className="text-pretty border-l-2 border-[#00b4d8] pl-4 leading-7 text-slate-700"><span className="mr-2 font-bold text-[#234093]">0{index + 1}</span>{insight}</p>)}</div>
        </div>
      </section>

      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
        <form key={`${filter?.from}-${filter?.to}-${filter?.type}`} action={applyFilter} className="mx-auto grid max-w-7xl gap-3 px-5 py-4 sm:px-8 md:grid-cols-2 xl:grid-cols-8">
          <fieldset className="flex min-w-0 flex-wrap items-center gap-2 md:col-span-2 xl:col-span-8">
            <legend className="mr-1 text-xs font-semibold text-slate-600">Khoảng nhanh</legend>
            {([
              ['7d', '7 ngày'],
              ['30d', '30 ngày'],
              ['ytd', 'YTD'],
            ] as const).map(([preset, label]) => <button
              key={preset}
              className={activeDatePreset === preset ? 'report-focus min-h-11 rounded-full bg-[#234093] px-4 text-sm font-bold text-white' : 'report-focus min-h-11 rounded-full border border-slate-300 bg-white px-4 text-sm font-bold text-[#234093] hover:border-[#234093]'}
              type="button"
              aria-pressed={activeDatePreset === preset}
              disabled={!bundle || loading}
              onClick={() => applyDatePreset(preset)}
            >{label}</button>)}
            <span className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-slate-500" aria-live="polite">{activeDatePreset ? `Đang chọn ${activeDatePreset === 'ytd' ? 'YTD' : activeDatePreset === '7d' ? '7 ngày' : '30 ngày'}` : 'Tùy chọn'}</span>
          </fieldset>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Từ ngày<input className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" type="date" name="from" min={bundle?.metadata.min_ops_date} max={bundle?.metadata.max_ops_date} defaultValue={filter?.from ?? ''} required /></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Đến ngày<input className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" type="date" name="to" min={bundle?.metadata.min_ops_date} max={bundle?.metadata.max_ops_date} defaultValue={filter?.to ?? ''} required /></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Loại chuyến<select className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" name="type" defaultValue={filter?.type ?? 'all'}><option value="all">ARR + DEP</option><option value="A">ARR</option><option value="D">DEP</option></select></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">So sánh<select className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" name="comp" defaultValue={filter?.comp ?? 'previous'}><option value="previous">Kỳ trước</option><option value="year_ago">Cùng kỳ năm trước</option><option value="none">Không so sánh</option></select></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Hãng bay<input className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" name="airline" placeholder="VN,QH" defaultValue={filter?.airline.join(',')} /></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Đường bay<input className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" name="route" placeholder="HAN,SGN" defaultValue={filter?.route.join(',')} /></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Quốc gia<input className="report-focus mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" name="country" placeholder="Vietnam,Unknown" defaultValue={filter?.country.join(',')} /><input type="hidden" name="tz" value={filter?.tz ?? 'local'} /></label>
          <button className="report-focus min-h-11 self-end rounded-lg bg-[#234093] px-5 text-sm font-bold text-white hover:bg-[#172f77]" type="submit">Áp dụng</button>
        </form>
      </div>

      <div className="mx-auto max-w-7xl space-y-10 px-5 py-10 sm:px-8">
        {loading ? <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-cyan-900" role="status">Đang cập nhật số liệu…</div> : null}
        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert"><p className="font-semibold">Không thể tải báo cáo</p><p className="mt-1 text-sm">{error}</p>{parsed.filter ? <button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 text-sm font-bold text-white" onClick={() => void load(parsed.filter!)} type="button">Thử lại</button> : null}</div> : null}

        {bundle ? <>
          <section aria-labelledby="kpi-title">
            <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-[0.16em] text-[#234093]">Operating pulse</p><h2 id="kpi-title" className="mt-2 text-3xl font-bold tracking-tight text-[#102033]">Tóm tắt vận hành</h2></div><div className="text-right text-xs text-slate-500"><p>Cập nhật: {new Date(bundle.data_as_of).toLocaleString('vi-VN')}</p><p>Mã truy vấn: {bundle.request_hash.slice(0, 12)}</p></div></div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <KpiCard label="Tổng chuyến" value={current?.flights ?? null} delta={comparisonDelta(current?.flights ?? null, comparison?.flights ?? null)} comparisonLabel={comparisonLabel} />
              <KpiCard label="ARR" value={current?.arrivals ?? null} delta={comparisonDelta(current?.arrivals ?? null, comparison?.arrivals ?? null)} comparisonLabel={comparisonLabel} />
              <KpiCard label="DEP" value={current?.departures ?? null} delta={comparisonDelta(current?.departures ?? null, comparison?.departures ?? null)} comparisonLabel={comparisonLabel} />
              <KpiCard label="Pax đã báo cáo" value={current?.reported_pax ?? null} delta={comparisonDelta(current?.reported_pax ?? null, comparison?.reported_pax ?? null)} comparisonLabel={comparisonLabel} note="Không suy diễn Pax = 0 là đã báo cáo." />
              <KpiCard label="Pax coverage" value={bundle.kpis.pax_coverage.percent} suffix="%" delta={null} comparisonLabel="leg đến hạn T+1" note={`${formatNumber(bundle.kpis.pax_coverage.reported_legs)}/${formatNumber(bundle.kpis.pax_coverage.due_legs)} leg`} />
            </div>
          </section>

          <section aria-labelledby="trend-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#234093]">Continuous trend</p><h2 id="trend-title" className="mt-2 text-2xl font-bold text-[#102033]">Sản lượng theo Ops Date</h2><p className="mt-2 text-sm text-slate-600">{bundle.metadata.day_count} ngày liên tục · ngày không có chuyến hiển thị 0, ngày chưa đủ dữ liệu có trạng thái riêng.</p>
            <div className="mt-6"><TimelineChart rows={bundle.timeline} totalFlights={bundle.kpis.current.flights} dayCount={bundle.metadata.day_count} /></div>
            {bundle.metadata.timeline_has_more ? <div className="mt-5 flex justify-center"><button className="report-focus min-h-11 rounded-lg border border-[#234093] px-5 text-sm font-bold text-[#234093] disabled:opacity-60" type="button" disabled={loadingMore} onClick={() => void loadMoreTimeline()}>{loadingMore ? 'Đang tải…' : 'Tải dãy ngày tiếp theo'}</button></div> : null}
          </section>

          <section aria-labelledby="breakdown-title"><p className="text-sm font-bold uppercase tracking-[0.16em] text-[#234093]">Traffic composition</p><h2 id="breakdown-title" className="mt-2 text-3xl font-bold tracking-tight">Cơ cấu sản lượng</h2><div className="mt-6 grid gap-5 lg:grid-cols-2"><BreakdownTable title="Hãng bay" rows={bundle.breakdowns.airline} showShareBars /><BreakdownTable title="Đường bay" rows={bundle.breakdowns.route} showShareBars /><BreakdownTable title="Quốc gia" rows={bundle.breakdowns.country} /><BreakdownTable title="Nhóm tàu bay" rows={bundle.breakdowns.aircraft_group} /></div></section>

          <section className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <article className="rounded-2xl bg-[#081322] p-6 text-white"><p className="text-sm font-bold uppercase tracking-[0.16em] text-[#42c1c7]">Data quality</p><h2 className="mt-2 text-2xl font-bold">Chất lượng & độ phủ</h2><dl className="mt-6 grid gap-4 sm:grid-cols-3"><div><dt className="text-sm text-slate-300">Country Unknown</dt><dd className="mt-1 text-2xl font-bold tabular-nums">{formatNumber(bundle.quality.unknown_country_legs)}</dd></div><div><dt className="text-sm text-slate-300">Pax đến hạn còn thiếu</dt><dd className="mt-1 text-2xl font-bold tabular-nums">{formatNumber(bundle.quality.pax_due_missing_legs)}</dd></div><div><dt className="text-sm text-slate-300">Duplicate quarantine</dt><dd className="mt-1 text-2xl font-bold tabular-nums">{formatNumber(bundle.quality.quarantined_duplicate_candidates)}</dd></div></dl><ul className="mt-6 space-y-2 text-sm leading-6 text-slate-300">{bundle.quality.notes.map((note) => <li key={note}>• {note}</li>)}</ul></article>
            <article className="rounded-2xl border border-slate-200 bg-white p-6"><p className="text-sm font-bold uppercase tracking-[0.16em] text-[#234093]">Methodology</p><h2 className="mt-2 text-2xl font-bold">Cách đọc báo cáo</h2><p className="mt-4 text-sm leading-7 text-slate-600">Aggregate dưới 3 leg được ẩn hoặc gộp vào “Khác”. Pax coverage dùng các leg đã đến hạn T+1; cargo/ferry vẫn nằm trong mẫu số cho đến khi có cờ miễn trừ chuẩn.</p><a className="report-focus mt-5 inline-flex min-h-11 items-center rounded-lg border border-[#234093] px-4 text-sm font-bold text-[#234093]" href={`${'/api/report/v1/export'}?${toTrafficReportSearchParams(bundle.metadata.normalized_filter).toString()}`}>Tải CSV aggregate</a></article>
          </section>
        </> : null}
      </div>
    </>
  );
}
