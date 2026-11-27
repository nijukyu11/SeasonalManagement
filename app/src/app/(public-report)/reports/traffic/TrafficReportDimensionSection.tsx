'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  buildDimensionUrl,
  isTrafficDimensionResponse,
  type NormalizedTrafficReportFilter,
  type TrafficDimension,
  type TrafficDimensionResponse,
  type TrafficDimensionRow,
  type TrafficDimensionSort,
  type TrafficMarketDimension,
  type TrafficType,
} from '@/lib/trafficReportContract';
import {
  buildTrafficReportV2DimensionUrl,
  fetchTrafficReportV2DimensionPage,
  fetchTrafficReportV2DimensionShare,
  TrafficReportVersionChangedError,
} from '@/lib/trafficReportDataAdapter';
import type { TrafficDimensionShareResponse } from '@/lib/trafficReportV2Contract';
import { formatUiError } from '@/lib/uiDisplayText';
import { ScopeSelector } from './TrafficReportTrend';
import { TrafficDimensionShareDonut } from './TrafficDimensionShareDonut';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function formatNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? numberFormat.format(value as number) : '—';
}
function formatShare(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${percentFormat.format((value as number) * 100)}%` : '—';
}

function legacyDimensionShare(
  payload: TrafficDimensionResponse,
  dimension: TrafficDimension,
  metric: 'flights' | 'reported_pax',
): TrafficDimensionShareResponse {
  const shareField = metric === 'flights' ? 'flight_share' : 'pax_share';
  const valueField = metric === 'flights' ? 'flights' : 'reported_pax';
  const ranked = payload.rows
    .flatMap((row) => row[valueField] == null || row[shareField] == null ? [] : [{
      key: row.key,
      label: row.label,
      value: Number(row[valueField]),
      share: Number(row[shareField]),
    }])
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'vi'));
  const totalValue = ranked.length === 0
    ? null
    : ranked.reduce((sum, row) => sum + row.value, 0);
  const topRows = ranked.slice(0, 10);
  const topValue = topRows.reduce((sum, row) => sum + row.value, 0);
  const otherValue = totalValue == null ? 0 : Math.max(0, totalValue - topValue);
  return {
    contract_version: 'traffic-report-v2',
    dimension,
    metric,
    type: payload.type,
    limit: 10,
    total_value: totalValue,
    top_rows: topRows,
    other: totalValue != null && totalValue > 0 && otherValue > 0
      ? { label: 'Khác', value: otherValue, share: otherValue / totalValue }
      : null,
    source_watermark: 0,
    read_version_token: 'legacy-v1',
  };
}

export function TrafficReportDimensionSection({ kind, filter, scope, marketDimension = 'route', readVersion = 'v1', expectedWatermark, readVersionToken, comparisonRange, onScopeChange, onMarketDimensionChange, onVersionChanged }: {
  kind: 'market' | 'airline';
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  marketDimension?: TrafficMarketDimension;
  readVersion?: 'v1' | 'v2';
  expectedWatermark?: number;
  readVersionToken?: string;
  comparisonRange?: { from: string; to: string; mode?: string } | null;
  onScopeChange: (scope: TrafficType) => void;
  onMarketDimensionChange?: (dimension: TrafficMarketDimension) => void;
  onVersionChanged?: () => void;
}) {
  const dimension: TrafficDimension = kind === 'airline' ? 'airline' : marketDimension;
  const [sort, setSort] = useState<TrafficDimensionSort>('flights');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TrafficDimensionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flightShare, setFlightShare] = useState<TrafficDimensionShareResponse | null>(null);
  const [paxShare, setPaxShare] = useState<TrafficDimensionShareResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(true);
  const [flightShareError, setFlightShareError] = useState<string | null>(null);
  const [paxShareError, setPaxShareError] = useState<string | null>(null);
  const [comparisonMap, setComparisonMap] = useState<Record<string, TrafficDimensionRow> | null>(null);
  const [comparisonTotals, setComparisonTotals] = useState<{ flights: number; pax: number } | null>(null);
  const tableControllerRef = useRef<AbortController | null>(null);
  const shareControllerRef = useRef<AbortController | null>(null);

  const loadTable = useCallback(async () => {
    tableControllerRef.current?.abort();
    const controller = new AbortController();
    tableControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const loadMain = async () => {
        if (readVersion === 'v2') {
          if (expectedWatermark === undefined || !readVersionToken) {
            throw new Error('Phiên bản dữ liệu mới nhất chưa sẵn sàng.');
          }
          return fetchTrafficReportV2DimensionPage(filter, dimension, scope, sort, page, 20, expectedWatermark, readVersionToken, { signal: controller.signal });
        }
        const response = await fetch(buildDimensionUrl(filter, dimension, scope, sort, page, 20), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
        const result: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error('Không thể tải bảng dữ liệu. Vui lòng thử lại.');
        if (!isTrafficDimensionResponse(result)) throw new Error('Bảng dữ liệu chưa sẵn sàng.');
        return result;
      };

      const loadComp = async (): Promise<TrafficDimensionResponse | null> => {
        if (!comparisonRange || !comparisonRange.from || !comparisonRange.to) return null;
        const compFilter: NormalizedTrafficReportFilter = {
          ...filter,
          from: comparisonRange.from,
          to: comparisonRange.to,
          comp: 'none',
        };
        if (readVersion === 'v2') {
          if (expectedWatermark === undefined || !readVersionToken) return null;
          return fetchTrafficReportV2DimensionPage(compFilter, dimension, scope, 'flights', 1, 732, expectedWatermark, readVersionToken, { signal: controller.signal });
        }
        const response = await fetch(buildDimensionUrl(compFilter, dimension, scope, 'flights', 1, 732), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
        const result: unknown = await response.json().catch(() => null);
        if (!response.ok || !isTrafficDimensionResponse(result)) return null;
        return result;
      };

      const [mainResult, compResult] = await Promise.allSettled([loadMain(), loadComp()]);
      if (controller.signal.aborted) return;

      if (mainResult.status === 'fulfilled') {
        setData(mainResult.value);
      } else {
        if (mainResult.reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setError(formatUiError(mainResult.reason, 'Không thể tải bảng dữ liệu.'));
      }

      if (compResult.status === 'fulfilled' && compResult.value) {
        const rows = compResult.value.rows ?? [];
        const map: Record<string, TrafficDimensionRow> = {};
        let totalFlights = 0;
        let totalPax = 0;
        for (const row of rows) {
          map[row.key] = row;
          if (row.flights != null && Number.isFinite(row.flights)) totalFlights += row.flights;
          if (row.reported_pax != null && Number.isFinite(row.reported_pax)) totalPax += row.reported_pax;
        }
        setComparisonMap(map);
        setComparisonTotals({ flights: totalFlights, pax: totalPax });
      } else {
        setComparisonMap(null);
        setComparisonTotals(null);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setError(formatUiError(reason, 'Không thể tải bảng dữ liệu.'));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [comparisonRange, dimension, expectedWatermark, filter, onVersionChanged, page, readVersion, readVersionToken, scope, sort]);

  const loadShares = useCallback(async () => {
    shareControllerRef.current?.abort();
    const controller = new AbortController();
    shareControllerRef.current = controller;
    setShareLoading(true);
    setFlightShareError(null);
    setPaxShareError(null);
    const loadMetric = async (metric: 'flights' | 'reported_pax') => {
      if (readVersion === 'v2') {
        if (expectedWatermark === undefined || !readVersionToken) throw new Error('Phiên bản dữ liệu mới nhất chưa sẵn sàng.');
        return fetchTrafficReportV2DimensionShare(filter, dimension, scope, metric, expectedWatermark, readVersionToken, { signal: controller.signal });
      }
      const sortValue: TrafficDimensionSort = metric === 'flights' ? 'flights' : 'reported_pax';
      const response = await fetch(buildDimensionUrl(filter, dimension, scope, sortValue, 1, 732), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !isTrafficDimensionResponse(result)) throw new Error('Dữ liệu tỷ trọng chưa sẵn sàng.');
      return legacyDimensionShare(result, dimension, metric);
    };
    const [flightsResult, paxResult] = await Promise.allSettled([loadMetric('flights'), loadMetric('reported_pax')]);
    if (controller.signal.aborted) return;
    const handleVersion = (reason: unknown) => {
      if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
      return formatUiError(reason, 'Không thể tải dữ liệu tỷ trọng.');
    };
    if (flightsResult.status === 'fulfilled') setFlightShare(flightsResult.value);
    else { setFlightShare(null); setFlightShareError(handleVersion(flightsResult.reason)); }
    if (paxResult.status === 'fulfilled') setPaxShare(paxResult.value);
    else { setPaxShare(null); setPaxShareError(handleVersion(paxResult.reason)); }
    setShareLoading(false);
  }, [dimension, expectedWatermark, filter, onVersionChanged, readVersion, readVersionToken, scope]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTable(), 0);
    return () => { window.clearTimeout(timer); tableControllerRef.current?.abort(); };
  }, [loadTable]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadShares(), 0);
    return () => { window.clearTimeout(timer); shareControllerRef.current?.abort(); };
  }, [loadShares]);

  const title = kind === 'market' ? 'Sản lượng theo thị trường' : 'Sản lượng theo hãng hàng không';
  const description = kind === 'market'
    ? 'Đối chiếu tỷ trọng chuyến bay và sản lượng khách theo chặng bay hoặc quốc gia. Sản lượng khách chỉ tính số khách đã báo cáo.'
    : 'Đối chiếu tỷ trọng chuyến bay và sản lượng khách giữa các hãng. Sản lượng khách chỉ tính số khách đã báo cáo.';
  const groupLabel = dimension === 'route' ? 'Chặng bay' : dimension === 'country' ? 'Quốc gia' : 'Hãng hàng không';
  const visibleRows = data?.rows ?? [];
  const hasComparison = Boolean(comparisonRange && comparisonMap && comparisonTotals);
  const hotspots = useMemo(() => {
    if (!comparisonMap || !data?.rows || data.rows.length === 0) return null;
    const items: Array<{
      key: string;
      label: string;
      deltaPax: number | null;
      deltaFlights: number;
      pct: number | null;
    }> = [];
    for (const row of data.rows) {
      const prev = comparisonMap[row.key];
      const curFlights = row.flights ?? 0;
      const prevFlights = prev?.flights ?? 0;
      const deltaFlights = curFlights - prevFlights;
      const curPax = row.reported_pax ?? (curFlights === 0 ? 0 : null);
      const prevPax = prev?.reported_pax ?? (prevFlights === 0 ? 0 : null);
      const deltaPax = (curPax != null && prevPax != null) ? curPax - prevPax : null;
      const pct = (deltaPax != null && prevPax && prevPax > 0)
        ? (deltaPax / prevPax) * 100
        : (prevFlights > 0 ? (deltaFlights / prevFlights) * 100 : null);
      if (deltaPax != null && deltaPax !== 0) {
        items.push({ key: row.key, label: row.label, deltaPax, deltaFlights, pct });
      } else if (deltaFlights !== 0) {
        items.push({ key: row.key, label: row.label, deltaPax: null, deltaFlights, pct });
      }
    }
    const score = (item: (typeof items)[number]) => item.deltaPax != null ? item.deltaPax : item.deltaFlights;
    const sorted = [...items].sort((a, b) => score(b) - score(a));
    const topGainers = sorted.filter((item) => score(item) > 0).slice(0, 3);
    const topDecliners = [...sorted].reverse().filter((item) => score(item) < 0).slice(0, 3);
    return { topGainers, topDecliners };
  }, [comparisonMap, data?.rows]);
  const topTitle = dimension === 'route' ? 'Top 10 chặng bay' : dimension === 'country' ? 'Top 10 Quốc gia' : 'Top 10 hãng hàng không';
  const exportHref = readVersion === 'v2' && expectedWatermark !== undefined && readVersionToken
    ? buildTrafficReportV2DimensionUrl(filter, dimension, scope, sort, 1, 732, expectedWatermark, readVersionToken, true)
    : buildDimensionUrl(filter, dimension, scope, sort, 1, 732, true);
  const tableScrollHintId = `${kind}-table-scroll-hint`;

  return (
    <section aria-labelledby={`${kind}-title`}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-sm font-bold text-blue-900">{kind === 'market' ? 'Thị trường' : 'Hãng hàng không'}</p>
          <h2 id={`${kind}-title`} className="mt-1 text-balance text-3xl font-bold text-slate-950">{title}</h2>
          <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">{description}</p>
        </div>
        <ScopeSelector value={scope} onChange={onScopeChange} label={`Phạm vi ${title.toLocaleLowerCase('vi-VN')}`} />
      </div>

      {kind === 'market' ? <fieldset className="mt-5 flex gap-2">
        <legend className="sr-only">Chọn chiều phân tích thị trường</legend>
        {([['route', 'Chặng bay'], ['country', 'Quốc gia']] as const).map(([value, label]) => <button
          key={value}
          className={cn('report-focus min-h-11 rounded-lg border px-4 text-sm font-bold focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2', dimension === value ? 'border-cyan-700 bg-cyan-50 text-cyan-950' : 'border-slate-300 bg-white text-slate-700 hover:border-cyan-700')}
          type="button"
          aria-pressed={dimension === value}
          onClick={() => onMarketDimensionChange?.(value)}
        >{label}</button>)}
      </fieldset> : null}

      <div className="mt-6 grid gap-5">
        <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h3 className="text-balance text-xl font-bold text-slate-950">{topTitle}</h3>
          <p className="mt-1 text-pretty text-sm leading-6 text-slate-600">Hai biểu đồ được xếp hạng độc lập để phản ánh đúng nhóm dẫn đầu của từng chỉ tiêu.</p>
          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            <TrafficDimensionShareDonut title="Tỷ trọng số chuyến" data={flightShare} loading={shareLoading} error={flightShareError} onRetry={() => void loadShares()} />
            <TrafficDimensionShareDonut title="Tỷ trọng sản lượng khách" data={paxShare} loading={shareLoading} error={paxShareError} onRetry={() => void loadShares()} />
          </div>

        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h3 className="text-balance text-lg font-bold text-slate-950">Bảng dữ liệu {groupLabel.toLocaleLowerCase('vi-VN')}</h3><p className="mt-1 text-xs text-slate-600">Số liệu được tổng hợp theo đúng phạm vi đang chọn.</p></div>
            <div className="flex flex-wrap items-end gap-2 print:hidden report-no-print">
              <label className="text-xs font-semibold text-slate-700">Sắp xếp
                <select className="report-focus ml-2 min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" value={sort} onChange={(event) => { setSort(event.target.value as TrafficDimensionSort); setPage(1); }}>
                  <option value="flights">Số chuyến</option>
                  <option value="reported_pax">Sản lượng khách</option>
                  <option value="flight_share">Tỷ trọng chuyến</option>
                  <option value="pax_share">Tỷ trọng sản lượng khách</option>
                  <option value="label">Tên</option>
                </select>
              </label>
              <a className="report-focus inline-flex min-h-11 items-center rounded-lg border border-blue-900 px-3 text-sm font-bold text-blue-900 hover:bg-blue-50 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" href={exportHref}>Tải bảng dữ liệu</a>
            </div>
          </div>

          {error ? <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900" role="alert"><p className="font-semibold">Không thể tải bảng dữ liệu</p><p className="mt-1">{error}</p><button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 font-bold text-white focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" type="button" onClick={() => void loadTable()}>Thử lại</button></div> : null}
          {hasComparison && hotspots && (hotspots.topGainers.length > 0 || hotspots.topDecliners.length > 0) ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Điểm nóng biến động</h4>
                <span className="text-[11px] text-slate-500">So với kỳ đối chiếu</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-emerald-200 bg-white p-3">
                  <p className="text-xs font-bold text-emerald-800">Top 3 tăng trưởng</p>
                  <ul className="mt-2 space-y-1.5 text-xs">
                    {hotspots.topGainers.map((item) => (
                      <li key={item.key} className="flex items-center justify-between text-slate-700">
                        <span className="max-w-[65%] truncate font-medium" title={item.label}>{item.label}</span>
                        <span className="tabular-nums font-semibold text-emerald-700">
                          +{formatNumber(item.deltaPax != null ? item.deltaPax : item.deltaFlights)} {item.deltaPax != null ? 'khách' : 'chuyến'}
                          {item.pct != null ? ` (+${percentFormat.format(item.pct)}%)` : ''}
                        </span>
                      </li>
                    ))}
                    {hotspots.topGainers.length === 0 ? <li className="text-slate-400">Không có biến động tăng</li> : null}
                  </ul>
                </div>
                <div className="rounded-lg border border-rose-200 bg-white p-3">
                  <p className="text-xs font-bold text-rose-800">Top 3 suy giảm</p>
                  <ul className="mt-2 space-y-1.5 text-xs">
                    {hotspots.topDecliners.map((item) => (
                      <li key={item.key} className="flex items-center justify-between text-slate-700">
                        <span className="max-w-[65%] truncate font-medium" title={item.label}>{item.label}</span>
                        <span className="tabular-nums font-semibold text-rose-700">
                          {formatNumber(item.deltaPax != null ? item.deltaPax : item.deltaFlights)} {item.deltaPax != null ? 'khách' : 'chuyến'}
                          {item.pct != null ? ` (${percentFormat.format(item.pct)}%)` : ''}
                        </span>
                      </li>
                    ))}
                    {hotspots.topDecliners.length === 0 ? <li className="text-slate-400">Không có biến động giảm</li> : null}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
          <p id={tableScrollHintId} className="mt-4 text-xs text-slate-600 sm:sr-only print:hidden report-no-print">Vuốt ngang để xem đầy đủ các cột.</p>
          <div
            className="report-focus mt-2 overflow-x-auto rounded-lg focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2 sm:mt-4 lg:overflow-visible"
            role="region"
            tabIndex={0}
            aria-label={`Bảng dữ liệu ${groupLabel.toLocaleLowerCase('vi-VN')}, có thể cuộn ngang trên màn hình nhỏ`}
            aria-describedby={tableScrollHintId}
          >
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <caption className="sr-only">{title} theo {groupLabel.toLocaleLowerCase('vi-VN')}</caption>
              <thead className="sticky top-[var(--report-filter-bar-height,72px)] z-20 bg-white">
                <tr className="border-b border-slate-300 bg-white text-slate-600 shadow-[0_1px_0_0_#cbd5e1]">
                  <th className="bg-white p-2">{groupLabel}</th>
                  <th className="w-28 bg-white p-2 text-right tabular-nums">Chuyến bay</th>
                  {hasComparison ? <th className="w-28 bg-white p-2 text-right tabular-nums">Kỳ đối chiếu (CB)</th> : null}
                  {hasComparison ? <th className="w-32 bg-white p-2 text-right tabular-nums">Chênh lệch CB</th> : null}
                  <th className="w-36 bg-white p-2 text-right tabular-nums">Tỷ trọng chuyến bay</th>
                  <th className="w-32 bg-white p-2 text-right tabular-nums">Sản lượng khách</th>
                  {hasComparison ? <th className="w-32 bg-white p-2 text-right tabular-nums">Kỳ đối chiếu (Khách)</th> : null}
                  {hasComparison ? <th className="w-40 bg-white p-2 text-right tabular-nums">Chênh lệch khách &amp; CTG</th> : null}
                  <th className="w-40 bg-white p-2 text-right tabular-nums">Tỷ trọng sản lượng khách</th>
                  {hasComparison ? <th className="w-32 bg-white p-2 text-right tabular-nums">Δ tỷ trọng khách</th> : null}
                </tr>
              </thead>
              <tbody>
                {!loading && !error && visibleRows.map((row) => {
                  const displayLabel = /^unknown$/i.test(row.label.trim()) ? 'Chưa xác định' : row.label;
                  const prev = comparisonMap ? comparisonMap[row.key] : undefined;
                  const prevFlights = prev?.flights ?? 0;
                  const curFlights = row.flights ?? 0;
                  const deltaFlights = curFlights - prevFlights;
                  const flightPct = prevFlights > 0 ? (deltaFlights / prevFlights) * 100 : null;
                  const isNewFlight = (!prev || prev.flights === 0) && curFlights > 0;
                  const isDroppedFlight = curFlights === 0 && prevFlights > 0;

                  const prevPax = prev?.reported_pax ?? (prev?.flights === 0 ? 0 : null);
                  const curPax = row.reported_pax;
                  const deltaPax = (curPax != null && prevPax != null) ? curPax - prevPax : null;
                  const paxPct = (deltaPax != null && prevPax && prevPax > 0) ? (deltaPax / prevPax) * 100 : null;
                  const ctgPts = (deltaPax != null && comparisonTotals && comparisonTotals.pax > 0)
                    ? (deltaPax / comparisonTotals.pax) * 100
                    : null;

                  const curPaxShare = row.pax_share;
                  const prevPaxShare = prev?.pax_share;
                  const deltaSharePts = (curPaxShare != null && prevPaxShare != null)
                    ? (curPaxShare - prevPaxShare) * 100
                    : null;

                  return (
                    <tr key={row.key} className="border-b border-slate-100">
                      <td className="p-2 font-semibold text-slate-800" title={displayLabel}>{displayLabel}</td>
                      <td className="w-28 p-2 text-right tabular-nums">{formatNumber(row.flights)}</td>
                      {hasComparison ? (
                        <td className="w-28 p-2 text-right tabular-nums text-slate-600">{formatNumber(prevFlights)}</td>
                      ) : null}
                      {hasComparison ? (
                        <td className="w-32 p-2 text-right tabular-nums">
                          {isNewFlight ? (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">Mới</span>
                          ) : isDroppedFlight ? (
                            <span className="inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-800">Ngừng</span>
                          ) : deltaFlights === 0 ? (
                            <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">0%</span>
                          ) : (
                            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', deltaFlights > 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>
                              {deltaFlights > 0 ? '+' : ''}{formatNumber(deltaFlights)} ({deltaFlights > 0 ? '+' : ''}{flightPct != null ? `${percentFormat.format(flightPct)}%` : ''})
                            </span>
                          )}
                        </td>
                      ) : null}
                      <td className="w-36 p-2 text-right tabular-nums">{formatShare(row.flight_share)}</td>
                      <td className="w-32 p-2 text-right tabular-nums">{formatNumber(row.reported_pax)}</td>
                      {hasComparison ? (
                        <td className="w-32 p-2 text-right tabular-nums text-slate-600">{formatNumber(prevPax)}</td>
                      ) : null}
                      {hasComparison ? (
                        <td className="w-40 p-2 text-right tabular-nums">
                          {deltaPax == null ? (
                            '—'
                          ) : (
                            <div>
                              <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', deltaPax > 0 ? 'bg-emerald-50 text-emerald-800' : deltaPax < 0 ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-700')}>
                                {deltaPax > 0 ? '+' : ''}{formatNumber(deltaPax)} ({prevPax === 0 && curPax && curPax > 0 ? 'Mới' : `${deltaPax > 0 ? '+' : ''}${paxPct != null ? percentFormat.format(paxPct) : 0}%`})
                              </span>
                              {ctgPts != null && Number.isFinite(ctgPts) ? (
                                <span className="mt-0.5 block text-[11px] text-slate-500 tabular-nums">
                                  CTG {ctgPts > 0 ? '+' : ''}{percentFormat.format(ctgPts)}%
                                </span>
                              ) : null}
                            </div>
                          )}
                        </td>
                      ) : null}
                      <td className="w-40 p-2 text-right tabular-nums">{formatShare(row.pax_share)}</td>
                      {hasComparison ? (
                        <td className="w-32 p-2 text-right tabular-nums">
                          {deltaSharePts == null || !Number.isFinite(deltaSharePts) ? (
                            '—'
                          ) : (
                            <span className={cn('font-semibold', deltaSharePts > 0 ? 'text-emerald-700' : deltaSharePts < 0 ? 'text-rose-700' : 'text-slate-600')}>
                              {deltaSharePts > 0 ? '+' : ''}{percentFormat.format(deltaSharePts)} điểm %
                            </span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
                {!loading && !error && visibleRows.length === 0 ? <tr><td className="p-4 text-sm text-slate-600" colSpan={hasComparison ? 10 : 5}>Chưa có dữ liệu trong phạm vi này.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {!loading && !error && data ? <div className="mt-4 flex items-center justify-between gap-3 print:hidden report-no-print">
            <p className="text-xs text-slate-600">Trang {data.page} · {numberFormat.format(data.total_rows)} nhóm</p>
            <div className="flex gap-2">
              <button className="report-focus min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-bold text-slate-700 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2 disabled:opacity-40" type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Trang trước</button>
              <button className="report-focus min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-bold text-slate-700 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2 disabled:opacity-40" type="button" disabled={!data.has_more || loading} onClick={() => setPage((current) => current + 1)}>Trang sau</button>
            </div>
          </div> : null}
        </article>
      </div>
    </section>
  );
}
