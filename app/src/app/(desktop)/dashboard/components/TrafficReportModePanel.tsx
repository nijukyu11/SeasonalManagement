'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { fetchTrafficReportV2Bundle } from '@/lib/trafficReportDataAdapter';
import type { TrafficReportFilter, TrafficType } from '@/lib/trafficReportContract';
import type { TrafficV2Bundle, TrafficV2MetricSet } from '@/lib/trafficReportV2Contract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Ho_Chi_Minh',
});

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function latestCompletedDate(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return shiftIsoDate(`${parts.year}-${parts.month}-${parts.day}`, -1);
}

function parseList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function formatNumber(value: number | null): string {
  return value === null ? '—' : numberFormat.format(value);
}

function statusLabel(status: TrafficV2MetricSet['status']): string {
  return {
    complete: 'Đầy đủ',
    partial: 'Chưa đủ Pax',
    missing: 'Thiếu dữ liệu',
    future: 'Chưa đến hạn',
    zero: 'Không có chuyến',
  }[status];
}

function MetricCard({ label, value, note }: { label: string; value: number | null; note: string }) {
  return (
    <article className="rounded-lg border border-surface-variant bg-surface p-4 shadow-sm">
      <h3 className="text-balance text-sm font-semibold text-on-surface-variant">{label}</h3>
      <p className="mt-2 text-2xl font-bold tabular-nums text-on-surface">{formatNumber(value)}</p>
      <p className="mt-1 text-pretty text-xs text-on-surface-variant">{note}</p>
    </article>
  );
}

function TrafficReportModeSkeleton() {
  return (
    <div className="space-y-3" role="status">
      <div className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-lg bg-surface-container" />)}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-surface-container" />
      <span className="sr-only">Đang tải dữ liệu Report</span>
    </div>
  );
}

export function TrafficReportModePanel() {
  const completedDate = useMemo(() => latestCompletedDate(), []);
  const initialFilter = useMemo<TrafficReportFilter>(() => ({
    from: shiftIsoDate(completedDate, -29),
    to: completedDate,
    type: 'all',
    airline: [],
    route: [],
    country: [],
    comp: 'previous',
    tz: 'local',
  }), [completedDate]);
  const [draft, setDraft] = useState({
    from: initialFilter.from ?? '',
    to: initialFilter.to ?? '',
    type: initialFilter.type,
    airlines: '',
    routes: '',
    countries: '',
  });
  const [filter, setFilter] = useState(initialFilter);
  const [bundle, setBundle] = useState<TrafficV2Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTrafficReportV2Bundle(filter, { signal: controller.signal })
      .then(setBundle)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Không thể tải dữ liệu Report.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filter, reloadKey]);

  const applyFilter = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.from || !draft.to || draft.from > draft.to) {
      setError('Phạm vi ngày chưa hợp lệ.');
      return;
    }
    setLoading(true);
    setError(null);
    setFilter({
      from: draft.from,
      to: draft.to,
      type: draft.type,
      airline: parseList(draft.airlines),
      route: parseList(draft.routes),
      country: parseList(draft.countries),
      comp: 'previous',
      tz: 'local',
    });
  }, [draft]);

  return (
    <section className="space-y-3" aria-labelledby="dashboard-report-mode-title">
      <header className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="dashboard-report-mode-title" className="text-balance text-lg font-bold text-on-surface">Số liệu Report</h2>
              <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">Report data</span>
              {bundle ? (
                <span className={cn(
                  'rounded-full px-2 py-1 text-xs font-semibold',
                  bundle.version.sourceMode === 'live' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800',
                )}>
                  {bundle.version.sourceMode === 'live' ? 'Live aggregate' : 'Snapshot fallback'}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-pretty text-sm text-on-surface-variant">
              Cùng contract tổng hợp với trang Report; không tính lại KPI từ bản ghi Dashboard.
            </p>
          </div>
          {bundle ? (
            <dl className="text-xs text-on-surface-variant">
              <div className="flex gap-2"><dt className="font-semibold">As-of</dt><dd className="tabular-nums">{dateTimeFormat.format(new Date(bundle.version.dataAsOf))}</dd></div>
              <div className="flex gap-2"><dt className="font-semibold">Watermark</dt><dd className="tabular-nums">{numberFormat.format(bundle.version.sourceWatermark)}</dd></div>
            </dl>
          ) : null}
        </div>
      </header>

      <form onSubmit={applyFilter} className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-pretty text-xs font-semibold text-on-surface-variant">
            Từ Ops Date
            <input type="date" required value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface" />
          </label>
          <label className="text-pretty text-xs font-semibold text-on-surface-variant">
            Đến Ops Date
            <input type="date" required value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface" />
          </label>
          <label className="text-pretty text-xs font-semibold text-on-surface-variant">
            Chiều bay
            <select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as TrafficType }))} className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface">
              <option value="all">Đến + đi</option>
              <option value="A">Đến</option>
              <option value="D">Đi</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" disabled={loading} className="min-h-11 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-50">Áp dụng bộ lọc</button>
          </div>
          <label className="text-pretty text-xs font-semibold text-on-surface-variant">
            Hãng bay (phân cách bằng dấu phẩy)
            <input value={draft.airlines} onChange={(event) => setDraft((current) => ({ ...current, airlines: event.target.value }))} placeholder="VN, VJ" className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface" />
          </label>
          <label className="text-pretty text-xs font-semibold text-on-surface-variant">
            Đường bay (phân cách bằng dấu phẩy)
            <input value={draft.routes} onChange={(event) => setDraft((current) => ({ ...current, routes: event.target.value }))} placeholder="HAN, SGN" className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface" />
          </label>
          <label className="text-pretty text-xs font-semibold text-on-surface-variant md:col-span-2">
            Quốc gia (phân cách bằng dấu phẩy)
            <input value={draft.countries} onChange={(event) => setDraft((current) => ({ ...current, countries: event.target.value }))} placeholder="Vietnam, Korea" className="mt-1 min-h-11 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface" />
          </label>
        </div>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="text-pretty font-semibold">{error}</p>
          <button type="button" onClick={() => { setLoading(true); setError(null); setReloadKey((value) => value + 1); }} className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold">Thử lại</button>
        </div>
      ) : null}
      {loading ? <TrafficReportModeSkeleton /> : null}
      {!loading && !error && bundle?.current.flights === 0 ? (
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-6 text-center shadow-sm">
          <h3 className="text-balance text-base font-bold text-on-surface">Không có chuyến bay trong phạm vi đã chọn</h3>
          <p className="mt-1 text-pretty text-sm text-on-surface-variant">Chọn phạm vi ngày rộng hơn hoặc xóa bớt điều kiện lọc.</p>
          <button type="button" onClick={() => { setDraft({ from: initialFilter.from ?? '', to: initialFilter.to ?? '', type: 'all', airlines: '', routes: '', countries: '' }); setLoading(true); setError(null); setFilter(initialFilter); }} className="mt-4 min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary">Đặt lại 30 ngày</button>
        </div>
      ) : null}
      {!loading && !error && bundle && bundle.current.flights > 0 ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Tổng chuyến bay" value={bundle.current.flights} note={`${formatNumber(bundle.current.arrivals)} đến · ${formatNumber(bundle.current.departures)} đi`} />
            <MetricCard label="Tổng hành khách" value={bundle.current.reportedPax} note={bundle.current.reportedPax === null ? '— nghĩa là chưa có dữ liệu Pax' : `${formatNumber(bundle.current.reportedLegs)}/${formatNumber(bundle.current.dueLegs)} chặng đã có Pax`} />
            <MetricCard label="Chặng thiếu Pax đến hạn" value={bundle.current.missingDueLegs} note={statusLabel(bundle.current.status)} />
            <MetricCard label="Chặng Pax bằng 0" value={bundle.current.trueZeroReportedLegs} note="Đã báo cáo 0, không phải thiếu dữ liệu" />
          </div>
          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
            <h3 className="text-balance text-base font-bold text-on-surface">Dữ liệu theo ngày</h3>
            <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Bảng số liệu Report theo ngày">
              <table className="min-w-[760px] w-full text-left text-sm">
                <thead className="border-b border-surface-variant text-xs font-semibold text-on-surface-variant">
                  <tr><th className="px-3 py-2">Ops Date</th><th className="px-3 py-2 text-right">Tổng</th><th className="px-3 py-2 text-right">Đến</th><th className="px-3 py-2 text-right">Đi</th><th className="px-3 py-2 text-right">Hành khách</th><th className="px-3 py-2">Trạng thái</th></tr>
                </thead>
                <tbody className="divide-y divide-surface-variant">
                  {bundle.timeline.map((row) => (
                    <tr key={row.opsDate}>
                      <td className="px-3 py-2 font-medium tabular-nums text-on-surface">{row.opsDate}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.flights)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.arrivals)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.departures)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.reportedPax)}</td>
                      <td className="px-3 py-2 text-pretty text-on-surface-variant">{statusLabel(row.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
