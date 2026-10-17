'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  buildDimensionUrl,
  isTrafficDimensionResponse,
  type NormalizedTrafficReportFilter,
  type TrafficDimension,
  type TrafficDimensionResponse,
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

function formatNumber(value: number | null): string {
  return value == null ? '—' : numberFormat.format(value);
}
function formatShare(value: number | null): string {
  return value == null ? '—' : `${percentFormat.format(value * 100)}%`;
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

export function TrafficReportDimensionSection({ kind, filter, scope, marketDimension = 'route', readVersion = 'v1', expectedWatermark, readVersionToken, onScopeChange, onMarketDimensionChange, onVersionChanged }: {
  kind: 'market' | 'airline';
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  marketDimension?: TrafficMarketDimension;
  readVersion?: 'v1' | 'v2';
  expectedWatermark?: number;
  readVersionToken?: string;
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
  const tableControllerRef = useRef<AbortController | null>(null);
  const shareControllerRef = useRef<AbortController | null>(null);

  const loadTable = useCallback(async () => {
    tableControllerRef.current?.abort();
    const controller = new AbortController();
    tableControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = readVersion === 'v2'
        ? expectedWatermark === undefined || !readVersionToken
          ? (() => { throw new Error('Phiên bản dữ liệu mới nhất chưa sẵn sàng.'); })()
          : await fetchTrafficReportV2DimensionPage(filter, dimension, scope, sort, page, 20, expectedWatermark, readVersionToken, { signal: controller.signal })
        : await (async () => {
          const response = await fetch(buildDimensionUrl(filter, dimension, scope, sort, page, 20), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
          const result: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error('Không thể tải bảng dữ liệu. Vui lòng thử lại.');
          if (!isTrafficDimensionResponse(result)) throw new Error('Bảng dữ liệu chưa sẵn sàng.');
          return result;
        })();
      if (!controller.signal.aborted) setData(payload);
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setError(formatUiError(reason, 'Không thể tải bảng dữ liệu.'));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [dimension, expectedWatermark, filter, onVersionChanged, page, readVersion, readVersionToken, scope, sort]);

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
            <div className="flex flex-wrap items-end gap-2">
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
          <p id={tableScrollHintId} className="mt-4 text-xs text-slate-600 sm:sr-only">Vuốt ngang để xem đầy đủ các cột.</p>
          <div
            className="report-focus mt-2 overflow-x-auto rounded-lg focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2 sm:mt-4"
            role="region"
            tabIndex={0}
            aria-label={`Bảng dữ liệu ${groupLabel.toLocaleLowerCase('vi-VN')}, có thể cuộn ngang trên màn hình nhỏ`}
            aria-describedby={tableScrollHintId}
          >
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <caption className="sr-only">{title} theo {groupLabel.toLocaleLowerCase('vi-VN')}</caption>
              <thead><tr className="border-b border-slate-300 text-slate-600"><th className="p-2">{groupLabel}</th><th className="p-2 text-right">Chuyến bay</th><th className="p-2 text-right">Tỷ trọng chuyến bay</th><th className="p-2 text-right">Sản lượng khách</th><th className="p-2 text-right">Tỷ trọng sản lượng khách</th></tr></thead>
              <tbody>
                {!loading && !error && visibleRows.map((row) => {
                  const displayLabel = /^unknown$/i.test(row.label.trim()) ? 'Chưa xác định' : row.label;
                  return <tr key={row.key} className="border-b border-slate-100"><td className="p-2 font-semibold text-slate-800" title={displayLabel}>{displayLabel}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.flights)}</td><td className="p-2 text-right tabular-nums">{formatShare(row.flight_share)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.reported_pax)}</td><td className="p-2 text-right tabular-nums">{formatShare(row.pax_share)}</td></tr>;
                })}
                {!loading && !error && visibleRows.length === 0 ? <tr><td className="p-4 text-sm text-slate-600" colSpan={5}>Chưa có dữ liệu trong phạm vi này.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {!loading && !error && data ? <div className="mt-4 flex items-center justify-between gap-3">
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
