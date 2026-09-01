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
  TrafficReportVersionChangedError,
} from '@/lib/trafficReportDataAdapter';
import { ScopeSelector } from './TrafficReportTrend';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function formatNumber(value: number | null): string {
  return value == null ? '—' : numberFormat.format(value);
}

function formatShare(value: number | null): string {
  return value == null ? '—' : `${percentFormat.format(value * 100)}%`;
}

function ShareMetric({ value, tone }: {
  value: number | null;
  tone: 'flights' | 'pax';
}) {
  const width = `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%`;
  return (
    <div className="min-w-0">
      {value == null ? <span className="block min-h-5 text-pretty text-xs font-medium text-slate-500">Chưa có số liệu</span> : <>
        <span className="block h-2 w-full overflow-hidden rounded-sm bg-slate-100" aria-hidden="true">
          <span
            className={cn('block h-full rounded-sm', tone === 'flights' ? 'bg-blue-900' : 'border-2 border-cyan-700 bg-white')}
            style={{ width }}
          />
        </span>
        <strong className="mt-1 block text-right text-sm font-bold tabular-nums text-slate-800">{formatShare(value)}</strong>
      </>}
    </div>
  );
}

export function TrafficReportDimensionSection({ kind, filter, scope, marketDimension = 'route', readVersion = 'v1', expectedWatermark, onScopeChange, onMarketDimensionChange, onVersionChanged }: {
  kind: 'market' | 'airline';
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  marketDimension?: TrafficMarketDimension;
  readVersion?: 'v1' | 'v2';
  expectedWatermark?: number;
  onScopeChange: (scope: TrafficType) => void;
  onMarketDimensionChange?: (dimension: TrafficMarketDimension) => void;
  onVersionChanged?: () => void;
}) {
  const dimension: TrafficDimension = kind === 'airline' ? 'airline' : marketDimension;
  const [sort, setSort] = useState<TrafficDimensionSort>('flights');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TrafficDimensionResponse | null>(null);
  const [chartData, setChartData] = useState<TrafficDimensionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const tableControllerRef = useRef<AbortController | null>(null);
  const chartControllerRef = useRef<AbortController | null>(null);

  const loadTable = useCallback(async () => {
    tableControllerRef.current?.abort();
    const controller = new AbortController();
    tableControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = readVersion === 'v2'
        ? expectedWatermark === undefined
          ? (() => { throw new Error('Phiên bản dữ liệu live chưa sẵn sàng.'); })()
          : await fetchTrafficReportV2DimensionPage(filter, dimension, scope, sort, page, 50, expectedWatermark, { signal: controller.signal })
        : await (async () => {
          const response = await fetch(buildDimensionUrl(filter, dimension, scope, sort, page, 50), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
          const result: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error('Không thể tải bảng dữ liệu. Vui lòng thử lại.');
          if (!isTrafficDimensionResponse(result)) throw new Error('Bảng dữ liệu chưa sẵn sàng.');
          return result;
        })();
      if (!controller.signal.aborted) setData(payload);
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setError(reason instanceof Error ? reason.message : 'Không thể tải bảng dữ liệu.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [dimension, expectedWatermark, filter, onVersionChanged, page, readVersion, scope, sort]);

  const loadChart = useCallback(async () => {
    chartControllerRef.current?.abort();
    const controller = new AbortController();
    chartControllerRef.current = controller;
    setChartLoading(true);
    setChartError(null);
    try {
      const payload = readVersion === 'v2'
        ? expectedWatermark === undefined
          ? (() => { throw new Error('Phiên bản dữ liệu live chưa sẵn sàng.'); })()
          : await fetchTrafficReportV2DimensionPage(filter, dimension, scope, 'flights', 1, 50, expectedWatermark, { signal: controller.signal })
        : await (async () => {
          const response = await fetch(buildDimensionUrl(filter, dimension, scope, 'flights', 1, 50), { credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
          const result: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error('Không thể tải xếp hạng. Vui lòng thử lại.');
          if (!isTrafficDimensionResponse(result)) throw new Error('Xếp hạng chưa sẵn sàng.');
          return result;
        })();
      if (!controller.signal.aborted) setChartData(payload);
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setChartError(reason instanceof Error ? reason.message : 'Không thể tải xếp hạng.');
      }
    } finally {
      if (!controller.signal.aborted) setChartLoading(false);
    }
  }, [dimension, expectedWatermark, filter, onVersionChanged, readVersion, scope]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTable(), 0);
    return () => { window.clearTimeout(timer); tableControllerRef.current?.abort(); };
  }, [loadTable]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadChart(), 0);
    return () => { window.clearTimeout(timer); chartControllerRef.current?.abort(); };
  }, [loadChart]);

  const title = kind === 'market' ? 'Sản lượng theo thị trường' : 'Sản lượng theo hãng hàng không';
  const description = kind === 'market'
    ? 'Đối chiếu tỷ trọng chuyến bay và sản lượng khách theo chặng bay hoặc quốc gia. Sản lượng khách chỉ tính số khách đã báo cáo.'
    : 'Đối chiếu tỷ trọng chuyến bay và sản lượng khách giữa các hãng. Sản lượng khách chỉ tính số khách đã báo cáo.';
  const groupLabel = dimension === 'route' ? 'Chặng bay' : dimension === 'country' ? 'Quốc gia' : 'Hãng hàng không';
  const visibleRows = data?.rows ?? [];
  const chartRows = chartData?.rows.slice(0, 10) ?? [];
  const exportHref = readVersion === 'v2' && expectedWatermark !== undefined
    ? buildTrafficReportV2DimensionUrl(filter, dimension, scope, sort, 1, 732, expectedWatermark, true)
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

      <div className="mt-6 grid gap-5 xl:grid-cols-[0.9fr_1.4fr]">
        <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-balance text-lg font-bold text-slate-950">Top 10 {groupLabel.toLocaleLowerCase('vi-VN')} theo số chuyến</h3>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-y border-slate-100 py-3 text-xs font-semibold text-slate-700" aria-label="Chú thích tỷ trọng">
            <span className="inline-flex items-center gap-2"><span className="h-2 w-6 rounded-sm bg-blue-900" aria-hidden="true" />Tỷ trọng chuyến bay</span>
            <span className="inline-flex items-center gap-2"><span className="h-2 w-6 rounded-sm border-2 border-cyan-700 bg-white" aria-hidden="true" />Tỷ trọng sản lượng khách</span>
          </div>
          {chartLoading ? <div className="mt-5 space-y-3" role="status">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-9 animate-pulse rounded bg-slate-100" />)}<span className="sr-only">Đang tải biểu đồ {title.toLocaleLowerCase('vi-VN')}</span></div> : null}
          {chartError ? <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900" role="alert"><p className="font-semibold">Không thể tải xếp hạng</p><p className="mt-1">{chartError}</p><button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 font-bold text-white focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" type="button" onClick={() => void loadChart()}>Thử lại</button></div> : null}
          {!chartLoading && !chartError && chartRows.length === 0 ? <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"><p className="font-semibold">Chưa có dữ liệu để xếp hạng.</p><p className="mt-1">Hãy chọn phạm vi khác.</p></div> : null}
          {!chartLoading && !chartError && chartRows.length > 0 ? <ol className="mt-5 space-y-5">{chartRows.map((row) => <li key={row.key} aria-label={`${row.label}: tỷ trọng chuyến bay ${formatShare(row.flight_share)}, tỷ trọng sản lượng khách ${formatShare(row.pax_share)}`}>
            <div className="truncate text-sm font-semibold text-slate-800" title={row.label} aria-label={row.label}>{row.label}</div>
            <div className="mt-2 grid grid-cols-2 gap-4" aria-hidden="true">
              <ShareMetric value={row.flight_share} tone="flights" />
              <ShareMetric value={row.pax_share} tone="pax" />
            </div>
          </li>)}</ol> : null}
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
                {!loading && !error && visibleRows.map((row) => <tr key={row.key} className="border-b border-slate-100"><td className="p-2 font-semibold text-slate-800" title={row.label}>{row.label}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.flights)}</td><td className="p-2 text-right tabular-nums">{formatShare(row.flight_share)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.reported_pax)}</td><td className="p-2 text-right tabular-nums">{formatShare(row.pax_share)}</td></tr>)}
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
