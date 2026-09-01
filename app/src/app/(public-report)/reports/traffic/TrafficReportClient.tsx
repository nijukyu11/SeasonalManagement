'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import {
  buildOverviewUrl,
  buildTimelineUrl,
  detectTrafficReportDatePreset,
  getLatestCompletedOpsDate,
  getTrafficReportPresetRange,
  isTrafficReportBundle,
  parseTrafficReportPageState,
  toTrafficReportPageSearchParams,
  toTrafficReportSearchParams,
  type NormalizedTrafficReportFilter,
  type TrafficDatePreset,
  type TrafficReportBundle,
  type TrafficReportPageState,
  type TrafficTimelinePoint,
} from '@/lib/trafficReportContract';
import { downloadTrafficReportWorkbook } from '@/lib/trafficReportExcelExport';
import { getAverageFlightsPerSelectedDay } from '@/lib/trafficReportOperationalHours';
import {
  buildTrafficReportV2ExportUrl,
  fetchTrafficReportV2Bundle,
  fetchTrafficReportV2TimelinePage,
  toTrafficReportPresentationBundle,
  TrafficReportVersionChangedError,
} from '@/lib/trafficReportDataAdapter';
import { DayOfWeekChart, FleetMixChart, PeakHourChart } from './TrafficReportAdvancedCharts';
import { TrafficReportDimensionSection } from './TrafficReportDimensionSection';
import { TrafficReportFilters } from './TrafficReportFilters';
import { TrafficReportTrend } from './TrafficReportTrend';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const TRAFFIC_REPORT_V2_ENABLED = process.env.NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED === '1';

function formatNumber(value: number | null | undefined): string {
  return value == null ? '—' : numberFormat.format(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function comparisonDelta(current: number | null, previous: number | null, available: boolean): number | null {
  if (!available || current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function DeltaPill({ value, label }: { value: number; label: string }) {
  return (
    <span className={cn('inline-flex min-h-7 max-w-full items-center rounded-full px-2.5 text-pretty text-xs font-semibold leading-4', value >= 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>
      {`${value >= 0 ? '+' : ''}${percentFormat.format(value)}% · ${label}`}
    </span>
  );
}

function KpiMetric({ label, value, delta, comparisonLabel, divided = false }: {
  label: string;
  value: number | null;
  delta: number | null;
  comparisonLabel: string;
  divided?: boolean;
}) {
  return (
    <div className={cn('min-w-0', divided && 'border-l border-slate-200 pl-4')}>
      <dt className="text-pretty text-xs font-semibold leading-5 text-slate-600">{label}</dt>
      <dd className="mt-1 text-2xl font-bold text-slate-950 tabular-nums sm:text-3xl">{formatNumber(value)}</dd>
      {delta != null ? <div className="mt-3"><DeltaPill value={delta} label={comparisonLabel} /></div> : null}
    </div>
  );
}

function KpiCard({ label, flights, pax, flightDelta, paxDelta, comparisonLabel }: {
  label: string;
  flights: number | null;
  pax: number | null;
  flightDelta: number | null;
  paxDelta: number | null;
  comparisonLabel: string;
}) {
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-label={`${label}: ${formatNumber(flights)} chuyến bay, sản lượng khách ${formatNumber(pax)}`}>
      <h3 className="text-balance text-lg font-bold text-blue-950">{label}</h3>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <KpiMetric label="Sản lượng chuyến bay" value={flights} delta={flightDelta} comparisonLabel={comparisonLabel} />
        <KpiMetric label="Sản lượng khách" value={pax} delta={paxDelta} comparisonLabel={comparisonLabel} divided />
      </dl>
    </article>
  );
}

function buildInsights(bundle: TrafficReportBundle): string[] {
  const current = bundle.kpis.current;
  const comparison = bundle.kpis.comparison;
  const topAirline = bundle.breakdowns.airline.find((row) => !row.suppressed && row.label !== 'Khác');
  const comparisonAvailable = current.status === 'complete' && comparison.status === 'complete';
  const delta = comparisonDelta(current.flights, comparison.flights, comparisonAvailable);
  const arrivalPeak = bundle.breakdowns.peak_hour.reduce<(typeof bundle.breakdowns.peak_hour)[number] | null>((peak, row) => row.arrivals != null && (!peak || row.arrivals > (peak.arrivals ?? -1)) ? row : peak, null);
  const departurePeak = bundle.breakdowns.peak_hour.reduce<(typeof bundle.breakdowns.peak_hour)[number] | null>((peak, row) => row.departures != null && (!peak || row.departures > (peak.departures ?? -1)) ? row : peak, null);
  const averagePeakArrivals = getAverageFlightsPerSelectedDay(arrivalPeak?.arrivals ?? null, bundle.metadata.day_count);
  const averagePeakDepartures = getAverageFlightsPerSelectedDay(departurePeak?.departures ?? null, bundle.metadata.day_count);
  return [
    bundle.kpis.peak_day.ops_date && bundle.kpis.peak_day.flights != null
      ? `Ngày cao điểm là ${formatDate(bundle.kpis.peak_day.ops_date)} với ${formatNumber(bundle.kpis.peak_day.flights)} chuyến.`
      : null,
    topAirline?.flights != null
      ? `${topAirline.label} có sản lượng chuyến bay cao nhất trong kỳ với ${formatNumber(topAirline.flights)} chuyến.`
      : null,
    arrivalPeak && departurePeak && averagePeakArrivals != null && averagePeakDepartures != null
      ? `Giờ cao điểm chuyến bay đến là ${arrivalPeak.hour_bucket}, trung bình ${numberFormat.format(Math.round(averagePeakArrivals))} chuyến/ngày; chuyến bay đi là ${departurePeak.hour_bucket}, trung bình ${numberFormat.format(Math.round(averagePeakDepartures))} chuyến/ngày.`
      : null,
    delta == null
      ? null
      : `Sản lượng chuyến bay ${delta >= 0 ? 'tăng' : 'giảm'} ${percentFormat.format(Math.abs(delta))}% so với kỳ đối chiếu.`,
  ].filter((insight): insight is string => insight != null);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" role="status">
      <div className="grid gap-4 lg:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-44 animate-pulse rounded-2xl bg-slate-200" />)}</div>
      <div className="h-80 animate-pulse rounded-2xl bg-slate-200" />
      <span className="sr-only">Đang tải báo cáo</span>
    </div>
  );
}

export default function TrafficReportClient() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [bundle, setBundle] = useState<TrafficReportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const exportControllerRef = useRef<AbortController | null>(null);
  const lastSuccessfulQueryRef = useRef<string | null>(null);

  const parsed = useMemo(() => {
    try {
      return { state: parseTrafficReportPageState(new URLSearchParams(searchParams.toString())), error: null };
    } catch (reason) {
      return { state: null, error: reason instanceof Error ? reason.message : 'Bộ lọc chưa hợp lệ.' };
    }
  }, [searchParams]);
  const globalQuery = parsed.state ? toTrafficReportSearchParams(parsed.state.filter).toString() : null;

  const requestBundle = useCallback(async (filter: TrafficReportPageState['filter']): Promise<TrafficReportBundle | null> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = TRAFFIC_REPORT_V2_ENABLED
        ? toTrafficReportPresentationBundle(await fetchTrafficReportV2Bundle(filter, { signal: controller.signal }))
        : await (async () => {
          const response = await fetch(buildOverviewUrl(filter), { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
          const result: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const message = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : 'Báo cáo tạm thời chưa thể cập nhật.';
            throw new Error(message);
          }
          if (!isTrafficReportBundle(result)) throw new Error('Dữ liệu báo cáo chưa sẵn sàng.');
          return result;
        })();
      setBundle(payload);
      lastSuccessfulQueryRef.current = toTrafficReportSearchParams(payload.metadata.normalized_filter).toString();
      return payload;
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Không thể tải báo cáo.');
      return null;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!parsed.state) return;
    if (lastSuccessfulQueryRef.current === globalQuery) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void requestBundle(parsed.state!.filter).then((payload) => {
        if (!active || !payload) return;
        const canonical = toTrafficReportPageSearchParams({ ...parsed.state!, filter: payload.metadata.normalized_filter }).toString();
        if (canonical !== searchParams.toString()) window.history.replaceState(null, '', `${pathname}?${canonical}`);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [globalQuery, parsed.error, parsed.state, pathname, requestBundle, searchParams]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    exportControllerRef.current?.abort();
  }, []);

  const pageState = parsed.state;
  const normalizedFilter = bundle?.metadata.normalized_filter ?? (pageState?.filter.from && pageState.filter.to ? pageState.filter as NormalizedTrafficReportFilter : null);

  const setUrlState = useCallback((next: TrafficReportPageState, mode: 'push' | 'replace' = 'push') => {
    const url = `${pathname}?${toTrafficReportPageSearchParams(next).toString()}`;
    if (mode === 'replace') window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [pathname]);

  const applyFilter = async (nextFilter: NormalizedTrafficReportFilter): Promise<boolean> => {
    if (!pageState) return false;
    const payload = await requestBundle({ ...nextFilter, type: 'all' });
    if (!payload) return false;
    setUrlState({ ...pageState, filter: payload.metadata.normalized_filter });
    return true;
  };

  const applyDatePreset = (preset: TrafficDatePreset) => {
    if (!bundle || !pageState) return;
    const latest = bundle.metadata.latest_completed_ops_date ?? getLatestCompletedOpsDate(bundle.data_as_of, bundle.metadata.max_ops_date);
    const range = getTrafficReportPresetRange(preset, bundle.metadata.min_ops_date, latest);
    void applyFilter({ ...bundle.metadata.normalized_filter, ...range, type: 'all' });
  };

  const updateViewState = (patch: Partial<Omit<TrafficReportPageState, 'filter'>>) => {
    if (!pageState || !normalizedFilter) return;
    setUrlState({ ...pageState, ...patch, filter: normalizedFilter });
  };

  const applyTimeBasis = (tz: NormalizedTrafficReportFilter['tz']) => {
    if (!normalizedFilter || normalizedFilter.tz === tz) return;
    void applyFilter({ ...normalizedFilter, tz });
  };

  const exportExcel = async () => {
    if (!bundle || exportingExcel) return;
    exportControllerRef.current?.abort();
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setExportingExcel(true);
    setExportError(null);
    try {
      const rows = new Map<string, TrafficTimelinePoint>();
      let after: string | null = null;
      let hasMore = true;
      let requests = 0;
      while (hasMore && requests < 50) {
        let timeline: TrafficTimelinePoint[];
        let next: string | null;
        if (bundle.contract_version === 'traffic-report-v2') {
          if (typeof bundle.source_watermark !== 'number') throw new Error('Phiên bản dữ liệu live chưa sẵn sàng.');
          const payload = await fetchTrafficReportV2TimelinePage(bundle.metadata.normalized_filter, 'all', after, bundle.source_watermark, { signal: controller.signal });
          timeline = payload.timeline;
          hasMore = payload.hasMore;
          next = payload.nextCursor;
        } else {
          const response = await fetch(buildTimelineUrl(bundle.metadata.normalized_filter, 'all', after), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
          const payload = await response.json().catch(() => null) as { error?: unknown; timeline?: TrafficTimelinePoint[]; metadata?: { timeline_has_more?: boolean; timeline_next_cursor?: string | null } } | null;
          if (!response.ok || !payload || !Array.isArray(payload.timeline) || !payload.metadata) throw new Error(payload?.error ? String(payload.error) : 'Không thể tải đủ dãy ngày cho Excel.');
          timeline = payload.timeline;
          hasMore = Boolean(payload.metadata.timeline_has_more);
          next = payload.metadata.timeline_next_cursor ?? null;
        }
        for (const row of timeline) rows.set(row.ops_date, row);
        if (hasMore && (!next || next === after)) throw new Error('Không thể hoàn tất dãy ngày cho Excel.');
        after = next;
        requests += 1;
      }
      if (hasMore) throw new Error('Phạm vi quá lớn để xuất trong một lần.');
      await downloadTrafficReportWorkbook(bundle, [...rows.values()].sort((left, right) => left.ops_date.localeCompare(right.ops_date)));
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) await requestBundle(bundle.metadata.normalized_filter);
        setExportError(reason instanceof Error ? reason.message : 'Không thể tạo file Excel.');
      }
    } finally {
      if (!controller.signal.aborted) setExportingExcel(false);
    }
  };

  const current = bundle?.kpis.current;
  const comparison = bundle?.kpis.comparison;
  const comparisonLabel = comparison?.mode === 'year_ago' ? 'cùng kỳ năm trước' : 'kỳ trước liền kề';
  const comparisonAvailable = current?.status === 'complete' && comparison?.status === 'complete';
  const insights = bundle ? buildInsights(bundle) : [];
  const fleetRows = useMemo(() => {
    if (!bundle) return [];
    const aircraftTypes = bundle.breakdowns.aircraft_type ?? [];
    return bundle.breakdowns.aircraft_group.map((group) => ({
      ...group,
      children: aircraftTypes.filter((aircraftType) => aircraftType.aircraft_group === group.label),
    }));
  }, [bundle]);
  const latestCompletedOpsDate = bundle ? (bundle.metadata.latest_completed_ops_date ?? getLatestCompletedOpsDate(bundle.data_as_of, bundle.metadata.max_ops_date)) : null;
  const activeDatePreset = bundle && latestCompletedOpsDate && normalizedFilter
    ? detectTrafficReportDatePreset(normalizedFilter.from, normalizedFilter.to, bundle.metadata.min_ops_date, latestCompletedOpsDate)
    : null;
  const projection = bundle?.metadata.projection;
  const reportUpdatedAt = projection?.refreshed_at ?? bundle?.data_as_of ?? null;
  const projectionNotice = projection?.status === 'stale'
    ? { title: 'Số liệu đang hiển thị theo lần cập nhật gần nhất.', tone: 'amber' as const }
    : projection?.status === 'failed'
      ? { title: 'Báo cáo chưa nhận được bản cập nhật mới. Vui lòng thử lại sau.', tone: 'rose' as const }
      : projection?.status === 'empty'
        ? { title: 'Chưa có dữ liệu cho báo cáo trong phạm vi này.', tone: 'rose' as const }
        : null;
  const visibleError = parsed.error ?? error;
  const readVersion = bundle?.contract_version === 'traffic-report-v2' ? 'v2' as const : 'v1' as const;
  const expectedWatermark = readVersion === 'v2' && typeof bundle?.source_watermark === 'number' ? bundle.source_watermark : undefined;
  const reloadVersionedBundle = useCallback(() => {
    if (normalizedFilter) void requestBundle(normalizedFilter);
  }, [normalizedFilter, requestBundle]);
  const aggregateCsvHref = bundle?.contract_version === 'traffic-report-v2' && typeof bundle.source_watermark === 'number'
    ? buildTrafficReportV2ExportUrl(bundle.metadata.normalized_filter, bundle.source_watermark)
    : bundle ? `/api/report/v1/export?${toTrafficReportSearchParams(bundle.metadata.normalized_filter).toString()}` : '#';

  return (
    <>
      <section className="bg-slate-950 text-white">
        <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-10">
          <p className="text-sm font-semibold text-cyan-300">Báo cáo vận hành công khai</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-balance text-3xl font-bold sm:text-4xl">Báo cáo sản lượng khai thác</h1>
              <p className="mt-3 max-w-3xl text-pretty text-sm leading-6 text-slate-300">Dữ liệu theo dãy ngày khai thác liên tục, không phụ thuộc mùa. Sản lượng khách chỉ tính số khách đã báo cáo.</p>
            </div>
            {normalizedFilter ? <p className="text-sm font-semibold text-slate-200">{formatDate(normalizedFilter.from)}–{formatDate(normalizedFilter.to)}</p> : null}
          </div>
        </div>
      </section>

      {bundle && normalizedFilter && latestCompletedOpsDate ? <TrafficReportFilters
        filter={normalizedFilter}
        minOpsDate={bundle.metadata.min_ops_date}
        maxOpsDate={bundle.metadata.max_ops_date}
        latestCompletedOpsDate={latestCompletedOpsDate}
        filterOptions={{
          airline: bundle.metadata.filter_options.airline,
          route: bundle.metadata.filter_options.route,
          country: bundle.metadata.filter_options.country ?? [],
        }}
        activePreset={activeDatePreset}
        loading={loading}
        onApply={applyFilter}
        onPreset={applyDatePreset}
      /> : null}

      <div className="mx-auto max-w-7xl space-y-12 px-5 py-8 sm:px-8 sm:py-10">
        {loading && !bundle && parsed.state ? <LoadingSkeleton /> : null}
        {loading && bundle ? <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-cyan-950" role="status">Đang cập nhật số liệu theo bộ lọc mới…</div> : null}
        {visibleError ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-950" role="alert"><p className="font-semibold">Không thể cập nhật báo cáo</p><p className="mt-1 text-sm">{visibleError}</p>{pageState ? <button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 text-sm font-bold text-white" type="button" onClick={() => void requestBundle(pageState.filter)}>Thử lại</button> : null}</div> : null}

        {bundle && normalizedFilter && pageState ? <>
          {projectionNotice ? <aside className={cn('rounded-xl border px-4 py-3 text-sm', projectionNotice.tone === 'rose' ? 'border-rose-300 bg-rose-50 text-rose-950' : 'border-amber-300 bg-amber-50 text-amber-950')} aria-label="Lưu ý cập nhật báo cáo" role="status"><p className="text-pretty font-semibold">{projectionNotice.title}</p></aside> : null}

          <section aria-labelledby="overview-title">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div><p className="text-sm font-bold text-blue-900">Sản lượng Tổng quan</p><h2 id="overview-title" className="mt-1 text-balance text-3xl font-bold text-slate-950">Các chỉ số nổi bật</h2></div>
              <div className="text-right text-xs text-slate-600">
                <p>{reportUpdatedAt ? `Cập nhật ${new Date(reportUpdatedAt).toLocaleString('vi-VN')}` : 'Chưa có thời điểm cập nhật'}</p>
                {typeof bundle.source_watermark === 'number' ? <p>Nguồn {readVersion === 'v2' ? 'live' : 'snapshot'} · watermark {numberFormat.format(bundle.source_watermark)}</p> : null}
              </div>
            </div>
            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              <KpiCard
                label="Tổng"
                flights={current?.flights ?? null}
                pax={current?.reported_pax ?? null}
                flightDelta={comparisonDelta(current?.flights ?? null, comparison?.flights ?? null, comparisonAvailable)}
                paxDelta={comparisonDelta(current?.reported_pax ?? null, comparison?.reported_pax ?? null, comparisonAvailable)}
                comparisonLabel={comparisonLabel}
              />
              <KpiCard
                label="Chuyến bay đến"
                flights={current?.arrivals ?? null}
                pax={current?.arrival_reported_pax ?? null}
                flightDelta={comparisonDelta(current?.arrivals ?? null, comparison?.arrivals ?? null, comparisonAvailable)}
                paxDelta={comparisonDelta(current?.arrival_reported_pax ?? null, comparison?.arrival_reported_pax ?? null, comparisonAvailable)}
                comparisonLabel={comparisonLabel}
              />
              <KpiCard
                label="Chuyến bay đi"
                flights={current?.departures ?? null}
                pax={current?.departure_reported_pax ?? null}
                flightDelta={comparisonDelta(current?.departures ?? null, comparison?.departures ?? null, comparisonAvailable)}
                paxDelta={comparisonDelta(current?.departure_reported_pax ?? null, comparison?.departure_reported_pax ?? null, comparisonAvailable)}
                comparisonLabel={comparisonLabel}
              />
            </div>
            <p className="mt-3 text-pretty text-xs leading-5 text-slate-600">Sản lượng khách chỉ tính số khách đã báo cáo; dấu — nghĩa là chưa có số liệu.</p>
            {!comparisonAvailable && comparison?.mode !== 'none' ? <p className="mt-4 text-sm text-slate-600">Chưa đủ dữ liệu để đối chiếu với {comparisonLabel}.</p> : null}
            <div className="mt-5 grid gap-3 md:grid-cols-2">{insights.map((insight, index) => <p key={insight} className="rounded-xl border-l-4 border-cyan-600 bg-white p-4 text-pretty text-sm leading-6 text-slate-700 shadow-sm"><span className="mr-2 font-bold text-blue-900">{index + 1}.</span>{insight}</p>)}</div>
          </section>

          <TrafficReportTrend filter={normalizedFilter} scope={pageState.trendType} readVersion={readVersion} expectedWatermark={expectedWatermark} onVersionChanged={reloadVersionedBundle} onScopeChange={(trendType) => updateViewState({ trendType })} />

          <TrafficReportDimensionSection
            key={`market-${globalQuery}-${pageState.marketDimension}-${pageState.marketType}`}
            kind="market"
            filter={normalizedFilter}
            scope={pageState.marketType}
            marketDimension={pageState.marketDimension}
            readVersion={readVersion}
            expectedWatermark={expectedWatermark}
            onVersionChanged={reloadVersionedBundle}
            onScopeChange={(marketType) => updateViewState({ marketType })}
            onMarketDimensionChange={(marketDimension) => updateViewState({ marketDimension })}
          />

          <TrafficReportDimensionSection
            key={`airline-${globalQuery}-${pageState.airlineType}`}
            kind="airline"
            filter={normalizedFilter}
            scope={pageState.airlineType}
            readVersion={readVersion}
            expectedWatermark={expectedWatermark}
            onVersionChanged={reloadVersionedBundle}
            onScopeChange={(airlineType) => updateViewState({ airlineType })}
          />

          <section aria-labelledby="operations-title">
            <div><p className="text-sm font-bold text-blue-900">Thông tin khai thác</p><h2 id="operations-title" className="mt-1 text-balance text-3xl font-bold text-slate-950">Giờ và cơ cấu khai thác</h2><p className="mt-2 text-pretty text-sm leading-6 text-slate-600">Xem giờ cao điểm của chuyến bay đến, chuyến bay đi và cơ cấu tàu bay trong phạm vi đã chọn.</p></div>
            <div className="mt-6">
              <PeakHourChart
                rows={bundle.breakdowns.peak_hour}
                monthlyRows={bundle.breakdowns.peak_hour_monthly ?? []}
                timeBasis={bundle.metadata.normalized_filter.tz}
                selectedDayCount={bundle.metadata.day_count}
                fromDate={bundle.metadata.normalized_filter.from}
                toDate={bundle.metadata.normalized_filter.to}
                onTimeBasisChange={applyTimeBasis}
              />
            </div>
            <div className="mt-5 grid gap-5 xl:grid-cols-2">
              <DayOfWeekChart rows={bundle.breakdowns.day_of_week ?? []} />
              <FleetMixChart rows={fleetRows} />
            </div>
          </section>

          <section>
            <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-balance text-2xl font-bold text-slate-950">Tải dữ liệu và cách đọc</h2>
              <p className="mt-3 text-pretty text-sm leading-6 text-slate-600">File tải xuống chỉ chứa dữ liệu tổng hợp theo bộ lọc đang áp dụng, không chứa thông tin từng chuyến bay.</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button className="report-focus min-h-11 rounded-lg bg-blue-900 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={exportingExcel} onClick={() => void exportExcel()}>{exportingExcel ? 'Đang tạo Excel…' : 'Tải Excel toàn báo cáo'}</button>
                <a className="report-focus inline-flex min-h-11 items-center rounded-lg border border-blue-900 px-4 text-sm font-bold text-blue-900 hover:bg-blue-50" href={aggregateCsvHref}>Tải CSV tổng hợp</a>
              </div>
              {exportError ? <p className="mt-3 text-sm font-semibold text-rose-800" role="alert">{exportError}</p> : null}
              <details className="mt-5 rounded-xl bg-slate-50 p-4"><summary className="report-focus cursor-pointer rounded-sm font-semibold text-blue-900">Ghi chú dữ liệu</summary><ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600"><li>• Sản lượng khách chỉ tính số khách đã báo cáo; dấu — nghĩa là chưa có số liệu.</li><li>• Quốc gia chưa xác định được hiển thị là Unknown.</li><li>• File tải xuống sử dụng cùng phạm vi và bộ lọc với trang báo cáo.</li></ul></details>
            </article>
          </section>
        </> : null}
      </div>
    </>
  );
}
