'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  buildPeakHourHeatmapUrl,
  isTrafficPeakHourHeatmapResponse,
  type NormalizedTrafficReportFilter,
  type TrafficPeakHourHeatmapBucket,
  type TrafficPeakHourHeatmapResponse,
  type TrafficTimeBasis,
  type TrafficType,
} from '@/lib/trafficReportContract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

type MonthRange = { month: string; from: string; to: string };

function shiftMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function endOfMonth(month: string): string {
  const next = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

function selectedMonths(from: string, to: string): MonthRange[] {
  const output: MonthRange[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shiftMonth(month, 1)) {
    output.push({ month, from: from > `${month}-01` ? from : `${month}-01`, to: to < endOfMonth(month) ? to : endOfMonth(month) });
  }
  return output.reverse();
}

function formatMonth(month: string): string {
  const [year, value] = month.split('-');
  return `Tháng ${Number(value)}/${year}`;
}

function heatClass(value: number | null, maxValue: number): string {
  if (value == null) return 'border border-dashed border-slate-300 bg-white text-slate-400';
  if (value === 0 || maxValue <= 0) return 'bg-slate-50 text-slate-600';
  const ratio = value / maxValue;
  if (ratio >= 0.8) return 'bg-blue-900 text-white';
  if (ratio >= 0.55) return 'bg-blue-600 text-white';
  if (ratio >= 0.3) return 'bg-sky-200 text-slate-950';
  return 'bg-sky-100 text-slate-800';
}

function HeatCell({ bucket, maxValue }: { bucket: TrafficPeakHourHeatmapBucket; maxValue: number }) {
  return <td className="p-1 text-center"><span className={cn('inline-flex min-h-9 min-w-10 items-center justify-center rounded-md px-1 text-xs font-bold tabular-nums', heatClass(bucket.flights, maxValue))}>{bucket.flights == null ? '—' : numberFormat.format(bucket.flights)}</span></td>;
}

function MonthMatrix({ data }: { data: TrafficPeakHourHeatmapResponse }) {
  const values = [...data.monthly_average, ...data.days.flatMap((day) => day.buckets)].flatMap((bucket) => bucket.flights == null ? [] : [bucket.flights]);
  const maxValue = Math.max(1, ...values);
  const hours = data.monthly_average.map((bucket) => bucket.hour_bucket);
  return <div className="mt-4">
    <p className="text-pretty text-xs leading-5 text-slate-600">TB tháng tính trên {numberFormat.format(data.complete_day_count)} ngày hoàn chỉnh; {numberFormat.format(data.partial_day_count)} ngày một phần và {numberFormat.format(data.missing_day_count)} ngày thiếu không tham gia mẫu số.</p>
    <div className="report-focus mt-3 max-h-dvh overflow-auto overscroll-contain rounded-lg border border-slate-200" role="region" tabIndex={0} aria-label={`Ma trận giờ cao điểm ${formatMonth(data.month)}, có thể cuộn ngang và dọc`}>
      <table className="min-w-[1216px] border-collapse text-sm">
        <thead><tr className="bg-slate-100 text-slate-700"><th className="sticky left-0 top-0 z-20 min-w-28 border-b border-r border-slate-200 bg-slate-100 p-2 text-left">Ngày Ops</th>{hours.map((hour) => <th key={hour} className="sticky top-0 z-10 min-w-[46px] border-b border-slate-200 bg-slate-100 p-1 text-center text-xs font-semibold tabular-nums">{hour}</th>)}</tr></thead>
        <tbody>
          <tr className="border-b-2 border-blue-200 bg-blue-50"><th className="sticky left-0 z-10 border-r border-blue-200 bg-blue-50 p-2 text-left font-bold text-blue-950">TB tháng</th>{data.monthly_average.map((bucket) => <HeatCell key={bucket.hour_bucket} bucket={bucket} maxValue={maxValue} />)}</tr>
          {data.days.map((day) => <tr key={day.ops_date} className={cn('border-b border-slate-100', day.is_month_peak && 'bg-amber-50')}>
            <th className={cn('sticky left-0 z-10 border-r border-slate-200 p-2 text-left font-semibold', day.is_month_peak ? 'bg-amber-50 text-amber-950' : 'bg-white text-slate-700')}>
              <span className="block tabular-nums">{dateFormat.format(new Date(`${day.ops_date}T00:00:00Z`))}</span>
              <span className="mt-1 block text-[11px] font-normal text-slate-500">{day.total_flights == null ? 'Thiếu dữ liệu' : `${numberFormat.format(day.total_flights)} chuyến`}</span>
              {day.is_month_peak ? <span className="mt-1 inline-flex rounded-full border border-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">Cao nhất</span> : null}
            </th>
            {day.buckets.map((bucket) => <HeatCell key={bucket.hour_bucket} bucket={bucket} maxValue={maxValue} />)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

export function TrafficPeakHourHeatmap({ filter, scope, timeBasis }: {
  filter: NormalizedTrafficReportFilter;
  scope: TrafficType;
  timeBasis: TrafficTimeBasis;
}) {
  const months = useMemo(() => selectedMonths(filter.from, filter.to), [filter.from, filter.to]);
  const [dataByMonth, setDataByMonth] = useState<Record<string, TrafficPeakHourHeatmapResponse>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openMonth, setOpenMonth] = useState<string | null>(months[0]?.month ?? null);
  const controllers = useRef(new Map<string, AbortController>());
  const baseKey = `${filter.from}|${filter.to}|${filter.airline.join(',')}|${filter.route.join(',')}|${filter.country.join(',')}|${scope}|${timeBasis}`;

  useEffect(() => {
    const activeControllers = controllers.current;
    activeControllers.forEach((controller) => controller.abort());
    activeControllers.clear();
    setDataByMonth({});
    setLoading({});
    setErrors({});
    setOpenMonth(months[0]?.month ?? null);
    return () => {
      activeControllers.forEach((controller) => controller.abort());
      activeControllers.clear();
    };
  }, [baseKey, months]);

  const loadMonth = useCallback(async (range: MonthRange) => {
    if (dataByMonth[range.month] || loading[range.month]) return;
    const controller = new AbortController();
    controllers.current.set(range.month, controller);
    setLoading((current) => ({ ...current, [range.month]: true }));
    setErrors((current) => ({ ...current, [range.month]: '' }));
    try {
      const response = await fetch(buildPeakHourHeatmapUrl(filter, scope, range.from, range.to), { signal: controller.signal, credentials: 'omit' });
      const payload: unknown = await response.json();
      if (!response.ok || !isTrafficPeakHourHeatmapResponse(payload)) throw new Error('Dữ liệu ma trận không hợp lệ.');
      setDataByMonth((current) => ({ ...current, [range.month]: payload }));
    } catch (error) {
      if (!controller.signal.aborted) setErrors((current) => ({ ...current, [range.month]: error instanceof Error ? error.message : 'Không thể tải ma trận.' }));
    } finally {
      if (!controller.signal.aborted) setLoading((current) => ({ ...current, [range.month]: false }));
      controllers.current.delete(range.month);
    }
  }, [dataByMonth, filter, loading, scope]);

  useEffect(() => {
    if (months[0]) void loadMonth(months[0]);
  }, [loadMonth, months]);

  return <section className="mt-6 border-t border-slate-200 pt-6" aria-labelledby="peak-hour-heatmap-title">
    <h4 id="peak-hour-heatmap-title" className="text-balance text-lg font-bold text-slate-950">Breakdown giờ cao điểm theo ngày</h4>
    <p className="mt-1 text-pretty text-sm leading-6 text-slate-600">Mỗi tháng mở thành một ma trận 24 giờ. Hàng TB tháng là trung bình số chuyến trong từng khung giờ, làm tròn số nguyên.</p>
    <div className="mt-4 space-y-3">{months.map((range) => <details key={`${baseKey}|${range.month}`} open={openMonth === range.month} className="rounded-xl border border-slate-200 bg-slate-50 p-4" onToggle={(event) => { if (event.currentTarget.open) { setOpenMonth(range.month); void loadMonth(range); } else if (openMonth === range.month) setOpenMonth(null); }}>
      <summary className="report-focus cursor-pointer rounded-sm font-bold text-blue-950">{formatMonth(range.month)}</summary>
      {loading[range.month] ? <p className="mt-4 text-sm text-slate-600" role="status">Đang tải ma trận theo ngày…</p> : null}
      {errors[range.month] ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert"><p>{errors[range.month]}</p><button type="button" className="report-focus mt-2 min-h-11 rounded-lg border border-red-300 bg-white px-3 font-bold" onClick={() => void loadMonth(range)}>Thử lại</button></div> : null}
      {dataByMonth[range.month] ? <MonthMatrix data={dataByMonth[range.month]} /> : null}
    </details>)}</div>
  </section>;
}
