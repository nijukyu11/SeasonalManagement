'use client';

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { fetchTrafficReportV2MonthDetail, TrafficReportVersionChangedError } from '@/lib/trafficReportDataAdapter';
import type { NormalizedTrafficReportFilter, TrafficTimelinePoint, TrafficType } from '@/lib/trafficReportContract';
import type { TrafficV2ApiMonthlyTimelinePoint } from '@/lib/trafficReportV2Contract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const monthFormat = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatNumber(value: number | null | undefined): string {
  return value == null ? '—' : numberFormat.format(value);
}

function formatMonth(value: string): string {
  return monthFormat.format(new Date(`${value}-15T12:00:00+07:00`));
}

function formatDate(value: string): string {
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function periodStatus(row: TrafficV2ApiMonthlyTimelinePoint): 'complete' | 'partial' {
  if (row.period_status) return row.period_status;
  const [yearValue, monthValue] = row.month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate();
  return row.from === `${row.month}-01`
    && row.to === `${row.month}-${String(lastDay).padStart(2, '0')}`
    && row.selected_day_count === lastDay
    ? 'complete'
    : 'partial';
}

function statusLabel(row: TrafficV2ApiMonthlyTimelinePoint): string {
  if (row.status === 'future') return 'Chưa đến kỳ';
  if (row.status === 'missing') return 'Thiếu dữ liệu';
  return periodStatus(row) === 'partial' ? 'Một phần' : 'Đầy đủ';
}

export function TrafficTrendTable({
  monthlyRows,
  fallbackDailyRows,
  filter,
  scope,
  readVersion,
  expectedWatermark,
  readVersionToken,
  onVersionChanged,
}: {
  monthlyRows: TrafficV2ApiMonthlyTimelinePoint[];
  fallbackDailyRows: TrafficTimelinePoint[];
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  readVersion: 'v1' | 'v2';
  expectedWatermark?: number;
  readVersionToken?: string;
  onVersionChanged?: () => void;
}) {
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [detailsByMonth, setDetailsByMonth] = useState<Record<string, TrafficTimelinePoint[]>>({});
  const [loadingMonths, setLoadingMonths] = useState<Set<string>>(new Set());
  const [errorsByMonth, setErrorsByMonth] = useState<Record<string, string>>({});
  const controllersRef = useRef(new Map<string, AbortController>());

  const loadMonth = useCallback(async (month: string) => {
    if (detailsByMonth[month] || loadingMonths.has(month)) return;
    if (readVersion === 'v1') {
      setDetailsByMonth((current) => ({ ...current, [month]: fallbackDailyRows.filter((row) => row.ops_date.startsWith(`${month}-`)) }));
      return;
    }
    if (expectedWatermark === undefined || !readVersionToken) {
      setErrorsByMonth((current) => ({ ...current, [month]: 'Dữ liệu chi tiết chưa sẵn sàng.' }));
      return;
    }
    controllersRef.current.get(month)?.abort();
    const controller = new AbortController();
    controllersRef.current.set(month, controller);
    setLoadingMonths((current) => new Set(current).add(month));
    setErrorsByMonth((current) => { const next = { ...current }; delete next[month]; return next; });
    try {
      const rows = await fetchTrafficReportV2MonthDetail(filter, scope, month, expectedWatermark, readVersionToken, { signal: controller.signal });
      if (!controller.signal.aborted) setDetailsByMonth((current) => ({ ...current, [month]: rows }));
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof TrafficReportVersionChangedError) onVersionChanged?.();
        setErrorsByMonth((current) => ({ ...current, [month]: reason instanceof Error ? reason.message : 'Không thể tải chi tiết ngày.' }));
      }
    } finally {
      if (!controller.signal.aborted) setLoadingMonths((current) => { const next = new Set(current); next.delete(month); return next; });
    }
  }, [detailsByMonth, expectedWatermark, fallbackDailyRows, filter, loadingMonths, onVersionChanged, readVersion, readVersionToken, scope]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => { for (const controller of controllers.values()) controller.abort(); };
  }, [filter, scope, readVersionToken]);

  useEffect(() => {
    setOpenMonths(new Set());
    setDetailsByMonth({});
    setErrorsByMonth({});
    setLoadingMonths(new Set());
  }, [filter, scope, readVersionToken]);

  const openAllMonths = useCallback(() => {
    const allMonths = monthlyRows.map((m) => m.month);
    setOpenMonths(new Set(allMonths));
    for (const month of allMonths) {
      if (!detailsByMonth[month]) void loadMonth(month);
    }
  }, [detailsByMonth, loadMonth, monthlyRows]);

  useEffect(() => {
    const handleBeforePrint = () => {
      openAllMonths();
    };
    window.addEventListener('beforeprint', handleBeforePrint);
    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
    };
  }, [openAllMonths]);

  const onToggle = (month: string, event: SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = event.currentTarget.open;
    setOpenMonths((current) => {
      const next = new Set(current);
      if (isOpen) next.add(month);
      else next.delete(month);
      return next;
    });
    if (isOpen) void loadMonth(month);
  };

  return (
    <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <summary className="report-focus min-h-11 cursor-pointer rounded-sm py-2 font-semibold text-blue-900 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2">Bảng dữ liệu xu hướng theo tháng</summary>
      <div className="mt-4 space-y-3">
        {monthlyRows.length > 0 ? (
          <div className="flex justify-end print:hidden report-no-print">
            <button
              type="button"
              onClick={openAllMonths}
              className="report-focus rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2"
            >
              Mở toàn bộ chi tiết tháng
            </button>
          </div>
        ) : null}
        {monthlyRows.map((month) => <details key={month.month} open={openMonths.has(month.month)} onToggle={(event) => onToggle(month.month, event)} className="rounded-lg border border-slate-200 bg-white">
          <summary className="report-focus min-h-11 cursor-pointer rounded-lg p-3 focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2">
            <span className="grid gap-1 text-sm sm:grid-cols-[1.5fr_1fr_1fr_auto] sm:items-center sm:gap-4">
              <strong className="capitalize text-slate-950">{formatMonth(month.month)}</strong>
              <span className="tabular-nums text-slate-700">{formatNumber(month.flights)} chuyến</span>
              <span className="tabular-nums text-slate-700">{formatNumber(month.reported_pax)} khách</span>
              <span className="font-semibold text-slate-600">{statusLabel(month)}</span>
            </span>
          </summary>
          <div className="border-t border-slate-200 p-3">
            {loadingMonths.has(month.month) ? <div className="space-y-2" role="status"><div className="h-8 animate-pulse rounded bg-slate-100" /><div className="h-8 animate-pulse rounded bg-slate-100" /><span className="sr-only">Đang tải chi tiết {formatMonth(month.month)}</span></div> : null}
            {errorsByMonth[month.month] ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" role="alert"><p>{errorsByMonth[month.month]}</p><button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 font-bold text-white focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" type="button" onClick={() => void loadMonth(month.month)}>Thử lại</button></div> : null}
            {!loadingMonths.has(month.month) && !errorsByMonth[month.month] && detailsByMonth[month.month] ? <div className="report-focus overflow-x-auto rounded-lg" role="region" tabIndex={0} aria-label={`Chi tiết ngày của ${formatMonth(month.month)}, có thể cuộn ngang`}>
              <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                <thead><tr className="border-b border-slate-300 text-slate-600"><th className="p-2">Ngày khai thác</th><th className="p-2 text-right">Chuyến bay</th><th className="p-2 text-right">Sản lượng khách</th></tr></thead>
                <tbody>{detailsByMonth[month.month].map((row) => <tr key={row.ops_date} className="border-b border-slate-100"><td className="p-2">{formatDate(row.ops_date)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.flights)}</td><td className="p-2 text-right tabular-nums">{formatNumber(row.reported_pax)}</td></tr>)}</tbody>
              </table>
            </div> : null}
          </div>
        </details>)}
      </div>
    </details>
  );
}
