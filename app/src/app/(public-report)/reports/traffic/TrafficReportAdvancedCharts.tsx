'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { TrafficBreakdownRow, TrafficDayOfWeekRow, TrafficMonthlyPeakRow, TrafficPeakHourRow, TrafficRegularFlight, TrafficTimeBasis, TrafficType } from '@/lib/trafficReportContract';
import {
  getAverageFlightsPerSelectedDay,
  getSelectedDayCountForMonth,
  orderTrafficPeakHours,
} from '@/lib/trafficReportOperationalHours';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dayLabels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
const fleetColors = ['#234093', '#00b4d8', '#526274', '#42c1c7'];

type FleetMixRow = TrafficBreakdownRow & {
  children?: readonly TrafficBreakdownRow[];
};

function valueOrDash(value: number | null): string {
  return value == null ? '—' : numberFormat.format(value);
}

function averageOrDash(value: number | null): string {
  return value == null ? '—' : numberFormat.format(Math.round(value));
}

function regularFlightCode(flight: TrafficRegularFlight): string {
  const airline = flight.airline.trim().toUpperCase();
  const flightNumber = flight.flight_number.replaceAll(' ', '').toUpperCase();
  return flightNumber.startsWith(airline) ? flightNumber : `${airline}${flightNumber}`;
}

function operatingPattern(days: TrafficRegularFlight['operating_days']): string {
  const normalized = [...new Set(days)].sort((left, right) => left - right);
  if (normalized.length === 7) return 'Hằng ngày';
  if (normalized.join(',') === '1,2,3,4,5') return 'Thứ 2–Thứ 6';
  if (normalized.join(',') === '6,7') return 'Cuối tuần';
  return normalized.map((day) => day === 7 ? 'CN' : `T${day + 1}`).join('/');
}

const peakHourScopeLabels: Record<TrafficType, string> = {
  all: 'Cả hai',
  A: 'Chuyến bay đến',
  D: 'Chuyến bay đi',
};

export function PeakHourChart({ rows, monthlyRows, timeBasis, selectedDayCount, fromDate, toDate, onTimeBasisChange }: {
  rows: TrafficPeakHourRow[];
  monthlyRows: TrafficMonthlyPeakRow[];
  timeBasis: TrafficTimeBasis;
  selectedDayCount: number;
  fromDate: string;
  toDate: string;
  onTimeBasisChange: (basis: TrafficTimeBasis) => void;
}) {
  const [scope, setScope] = useState<TrafficType>('all');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const orderedRows = orderTrafficPeakHours(rows, timeBasis).map((row) => ({
    ...row,
    averageArrivals: getAverageFlightsPerSelectedDay(row.arrivals, selectedDayCount),
    averageDepartures: getAverageFlightsPerSelectedDay(row.departures, selectedDayCount),
  }));
  const visibleTypes = useMemo(() => scope === 'all' ? ['A', 'D'] as const : [scope] as const, [scope]);
  const maxFlights = Math.max(1, ...orderedRows.flatMap((row) => visibleTypes.map((type) => type === 'A' ? row.averageArrivals ?? 0 : row.averageDepartures ?? 0)));
  const peakArrival = [...orderedRows]
    .filter((row) => !row.suppressed && row.averageArrivals != null)
    .sort((left, right) => (right.averageArrivals ?? 0) - (left.averageArrivals ?? 0))[0];
  const peakDeparture = [...orderedRows]
    .filter((row) => !row.suppressed && row.averageDepartures != null)
    .sort((left, right) => (right.averageDepartures ?? 0) - (left.averageDepartures ?? 0))[0];
  const activeKey = hoveredKey ?? selectedKey;
  const [activeHour, activeType] = activeKey?.split('|') ?? [];
  const activeRow = activeHour ? orderedRows.find((row) => row.hour_bucket === activeHour) ?? null : null;
  const activeAverage = activeRow ? (activeType === 'A' ? activeRow.averageArrivals : activeRow.averageDepartures) : null;
  const activeTotal = activeRow ? (activeType === 'A' ? activeRow.arrivals : activeRow.departures) : null;
  const activeRegularFlights = activeRow
    ? activeType === 'A'
      ? activeRow.regular_flights?.arrivals ?? []
      : activeRow.regular_flights?.departures ?? []
    : [];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !chartRef.current?.contains(target)) setSelectedKey(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, []);

  const closeDetails = () => {
    setHoveredKey(null);
    setSelectedKey(null);
  };

  const peakSummary = scope === 'A'
    ? peakArrival?.averageArrivals == null ? 'Chưa đủ dữ liệu để xác định giờ cao điểm chuyến bay đến.' : `Giờ cao điểm chuyến bay đến là ${peakArrival.hour_bucket}, trung bình ${averageOrDash(peakArrival.averageArrivals)} chuyến/ngày.`
    : scope === 'D'
      ? peakDeparture?.averageDepartures == null ? 'Chưa đủ dữ liệu để xác định giờ cao điểm chuyến bay đi.' : `Giờ cao điểm chuyến bay đi là ${peakDeparture.hour_bucket}, trung bình ${averageOrDash(peakDeparture.averageDepartures)} chuyến/ngày.`
      : peakArrival?.averageArrivals != null && peakDeparture?.averageDepartures != null
        ? `Giờ cao điểm chuyến bay đến là ${peakArrival.hour_bucket}, trung bình ${averageOrDash(peakArrival.averageArrivals)} chuyến/ngày; giờ cao điểm chuyến bay đi là ${peakDeparture.hour_bucket}, trung bình ${averageOrDash(peakDeparture.averageDepartures)} chuyến/ngày.`
        : 'Chưa đủ dữ liệu để xác định cả hai khung giờ cao điểm.';

  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-blue-900">Thông tin khai thác</p>
          <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">24 khung giờ khai thác</h3>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-slate-600">Trung bình số chuyến trong từng khung giờ trên mỗi ngày của {numberFormat.format(selectedDayCount)} ngày đã chọn. {peakSummary}</p>
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-slate-600">Phạm vi chuyến bay</legend>
            <div className="flex flex-wrap gap-2">{(['all', 'A', 'D'] as const).map((type) => <button
              key={type}
              className={cn('report-focus min-h-11 rounded-lg border px-3 text-sm font-bold', scope === type ? 'border-blue-900 bg-blue-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-blue-700')}
              type="button"
              aria-pressed={scope === type}
              onClick={() => { setScope(type); closeDetails(); }}
            >{peakHourScopeLabels[type]}</button>)}</div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-slate-600">Múi giờ hiển thị</legend>
            <div className="flex gap-2">{(['local', 'utc'] as const).map((basis) => <button
              key={basis}
              className={cn('report-focus min-h-11 rounded-lg border px-3 text-sm font-bold', timeBasis === basis ? 'border-[#234093] bg-[#234093] text-white' : 'border-slate-300 bg-white text-[#234093]')}
              type="button"
              aria-pressed={timeBasis === basis}
              onClick={() => { onTimeBasisChange(basis); closeDetails(); }}
            >{basis === 'local' ? 'Giờ địa phương' : 'UTC'}</button>)}</div>
          </fieldset>
        </div>
      </div>

      <p id="peak-hour-scroll-cue" className="mt-5 text-pretty text-xs leading-5 text-slate-500 sm:hidden">Vuốt ngang để xem đủ 24 khung giờ của ngày khai thác.</p>
      <div ref={chartRef} onPointerLeave={() => setHoveredKey(null)} onKeyDown={(event) => { if (event.key === 'Escape') closeDetails(); }}>
        <div
          className="report-focus mt-2 w-full overflow-x-auto overscroll-x-contain rounded-lg pb-2 sm:mt-6"
          role="region"
          tabIndex={0}
          aria-label="Biểu đồ 24 khung giờ khai thác, có thể cuộn ngang trên màn hình nhỏ"
          aria-describedby="peak-hour-scroll-cue"
        >
          <div className="relative flex h-72 w-full min-w-[960px] items-end gap-1 border-b border-slate-300 px-2 pt-6">
            {orderedRows.map((row) => <div key={row.hour_bucket} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              {row.suppressed ? <div className="mb-1 flex min-h-8 items-center justify-center rounded-t border border-dashed border-slate-400 bg-slate-50 text-xs font-bold text-slate-500">—</div> : <div className="flex h-full items-end justify-center gap-1">
                {visibleTypes.map((type) => {
                  const value = type === 'A' ? row.averageArrivals ?? 0 : row.averageDepartures ?? 0;
                  const key = `${row.hour_bucket}|${type}`;
                  const direction = peakHourScopeLabels[type];
                  return <button
                    key={key}
                    className="report-focus group relative flex h-full min-w-5 flex-1 cursor-pointer items-end justify-center rounded-sm"
                    type="button"
                    aria-label={`${row.hour_bucket}, ${direction}, trung bình ${averageOrDash(value)} chuyến mỗi ngày`}
                    aria-pressed={selectedKey === key}
                    onFocus={() => setSelectedKey(key)}
                    onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHoveredKey(key); }}
                    onClick={() => setSelectedKey((current) => current === key ? null : key)}
                  ><span
                    className={cn('pointer-events-none block w-full max-w-5 rounded-t', type === 'A' ? 'bg-blue-900' : 'border-x-2 border-t-2 border-cyan-700 bg-white', activeKey === key && 'ring-2 ring-slate-950 ring-offset-1')}
                    style={{ height: `${value === 0 ? 0 : Math.max(1, (value / maxFlights) * 100)}%` }}
                    aria-hidden="true"
                  /></button>;
                })}
              </div>}
              <span className="mt-2 text-center text-[11px] font-semibold tabular-nums text-slate-600">{row.hour_bucket}</span>
            </div>)}
          </div>
        </div>
        {activeRow && (activeType === 'A' || activeType === 'D') ? <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-live="polite" aria-label="Thông tin khung giờ đang chọn">
          <div className="flex items-start justify-between gap-4">
            <div><p className="text-balance font-bold text-slate-950">{activeRow.hour_bucket}–{`${String((Number(activeRow.hour_bucket.slice(0, 2)) + 1) % 24).padStart(2, '0')}:00`} · {peakHourScopeLabels[activeType]}</p><p className="mt-1 text-sm tabular-nums text-slate-700">Trung bình <strong>{averageOrDash(activeAverage)} chuyến/ngày</strong> · Tổng trong kỳ <strong>{valueOrDash(activeTotal)} chuyến</strong></p></div>
            {selectedKey ? <button className="report-focus min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700" type="button" onClick={closeDetails}>Đóng</button> : null}
          </div>
          <h4 className="mt-4 text-sm font-bold text-blue-950">Các chuyến bay thường lệ trong khung giờ</h4>
          {activeRegularFlights.length > 0 ? <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">{activeRegularFlights.map((flight) => <li key={`${flight.airline}-${flight.flight_number}-${flight.route}`} className="grid gap-1 rounded-lg bg-white px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <span className="font-bold text-slate-900">{regularFlightCode(flight)} · {flight.route || 'Unknown'}</span>
            <span className="text-slate-600 sm:text-right">{operatingPattern(flight.operating_days)} · thường lúc <span className="font-semibold tabular-nums">{flight.typical_time}</span></span>
          </li>)}</ul> : <p className="mt-2 text-pretty text-sm text-slate-600">Không ghi nhận lịch bay lặp ổn định trong kỳ. Chọn khung giờ khác để xem lịch thường lệ.</p>}
        </section> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold text-slate-600">{visibleTypes.map((type) => <span key={type} className="inline-flex items-center gap-2"><span className={cn('h-2 w-5 rounded-sm', type === 'A' ? 'bg-blue-900' : 'border-2 border-cyan-700 bg-white')} />{peakHourScopeLabels[type]}</span>)}</div>

      <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-[#234093]">Bảng dữ liệu 24 khung giờ</summary>
        <div className="report-focus mt-4 overflow-x-auto overscroll-x-contain rounded-lg" role="region" tabIndex={0} aria-label="Bảng dữ liệu 24 khung giờ, có thể cuộn ngang"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-slate-300"><th className="p-2">Giờ</th>{scope !== 'D' ? <><th className="p-2 text-right">TB chuyến bay đến/ngày</th><th className="p-2 text-right">Tổng chuyến bay đến trong kỳ</th></> : null}{scope !== 'A' ? <><th className="p-2 text-right">TB chuyến bay đi/ngày</th><th className="p-2 text-right">Tổng chuyến bay đi trong kỳ</th></> : null}</tr></thead><tbody>{orderedRows.map((row) => <tr key={row.hour_bucket} className="border-b border-slate-200"><td className="p-2 tabular-nums">{row.hour_bucket}</td>{scope !== 'D' ? <><td className="p-2 text-right tabular-nums">{averageOrDash(row.averageArrivals)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.arrivals)}</td></> : null}{scope !== 'A' ? <><td className="p-2 text-right tabular-nums">{averageOrDash(row.averageDepartures)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.departures)}</td></> : null}</tr>)}</tbody></table></div>
      </details>

      {monthlyRows.length > 0 ? <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-blue-900">Giờ cao điểm theo tháng</summary>
        <div className="report-focus mt-4 overflow-x-auto overscroll-x-contain rounded-lg" role="region" tabIndex={0} aria-label="Bảng giờ cao điểm theo tháng, có thể cuộn ngang"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-slate-300"><th className="p-2">Tháng</th>{scope !== 'D' ? <><th className="p-2">Giờ cao điểm chuyến bay đến</th><th className="p-2 text-right">TB chuyến bay đến/ngày</th><th className="p-2 text-right">Tổng chuyến bay đến</th></> : null}{scope !== 'A' ? <><th className="p-2">Giờ cao điểm chuyến bay đi</th><th className="p-2 text-right">TB chuyến bay đi/ngày</th><th className="p-2 text-right">Tổng chuyến bay đi</th></> : null}</tr></thead><tbody>{monthlyRows.map((row) => {
          const monthDayCount = getSelectedDayCountForMonth(row.month, fromDate, toDate);
          const averageArrivals = getAverageFlightsPerSelectedDay(row.arrival_flights, monthDayCount);
          const averageDepartures = getAverageFlightsPerSelectedDay(row.departure_flights, monthDayCount);
          return <tr key={row.month} className="border-b border-slate-200"><td className="p-2 tabular-nums">{row.month}</td>{scope !== 'D' ? <><td className="p-2 tabular-nums">{row.arrival_suppressed ? '—' : row.arrival_hour ?? '—'}</td><td className="p-2 text-right tabular-nums">{row.arrival_suppressed ? '—' : averageOrDash(averageArrivals)}</td><td className="p-2 text-right tabular-nums">{row.arrival_suppressed ? '—' : valueOrDash(row.arrival_flights)}</td></> : null}{scope !== 'A' ? <><td className="p-2 tabular-nums">{row.departure_suppressed ? '—' : row.departure_hour ?? '—'}</td><td className="p-2 text-right tabular-nums">{row.departure_suppressed ? '—' : averageOrDash(averageDepartures)}</td><td className="p-2 text-right tabular-nums">{row.departure_suppressed ? '—' : valueOrDash(row.departure_flights)}</td></> : null}</tr>;
        })}</tbody></table></div>
      </details> : null}
    </article>
  );
}

export function DayOfWeekChart({ rows }: { rows: TrafficDayOfWeekRow[] }) {
  const maxValue = Math.max(1, ...rows.map((row) => row.max_flights ?? 0));
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-bold text-blue-900">Mẫu khai thác theo tuần</p>
      <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">Chu kỳ Thứ trong tuần</h3>
      <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">Chiều cao cột là số chuyến trung bình; vạch dọc biểu diễn khoảng thấp nhất–cao nhất của từng Thứ trong kỳ.</p>
      <div className="mt-6 grid h-72 grid-cols-7 gap-2 border-b border-slate-300" aria-hidden="true">
        {rows.map((row) => {
          const average = row.average_flights ?? 0;
          const min = row.min_flights ?? 0;
          const max = row.max_flights ?? 0;
          return <div key={row.day_index} className="flex min-w-0 flex-col justify-end text-center">
            <div className="relative mx-auto h-56 w-full max-w-12">
              {!row.suppressed ? <>
                <span className="absolute left-1/2 w-px -translate-x-1/2 bg-slate-500" style={{ bottom: `${(min / maxValue) * 100}%`, height: `${((max - min) / maxValue) * 100}%` }} />
                <span className="absolute left-1/2 h-px w-4 -translate-x-1/2 bg-slate-500" style={{ bottom: `${(min / maxValue) * 100}%` }} />
                <span className="absolute left-1/2 h-px w-4 -translate-x-1/2 bg-slate-500" style={{ bottom: `${(max / maxValue) * 100}%` }} />
                <span className="absolute inset-x-1 bottom-0 rounded-t bg-[#00b4d8]" style={{ height: `${(average / maxValue) * 100}%` }} />
                <span className="absolute inset-x-0 text-xs font-bold tabular-nums text-[#102033]" style={{ bottom: `${Math.min(96, (average / maxValue) * 100 + 2)}%` }}>{averageOrDash(average)}</span>
              </> : <span className="absolute inset-x-0 bottom-2 rounded border border-dashed border-slate-400 bg-slate-50 py-2 text-xs font-bold text-slate-500">—</span>}
            </div>
            <span className="mt-2 min-h-9 text-xs font-semibold text-slate-600">{dayLabels[row.day_index - 1]}</span>
          </div>;
        })}
      </div>
      <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-[#234093]">Bảng dữ liệu theo Thứ</summary>
        <div className="report-focus mt-4 overflow-x-auto overscroll-x-contain rounded-lg" role="region" tabIndex={0} aria-label="Bảng dữ liệu theo Thứ, có thể cuộn ngang"><table className="w-full min-w-[600px] text-left text-sm"><thead><tr className="border-b border-slate-300"><th className="p-2">Thứ</th><th className="p-2 text-right">Số ngày</th><th className="p-2 text-right">Trung bình số chuyến</th><th className="p-2 text-right">Thấp nhất</th><th className="p-2 text-right">Cao nhất</th></tr></thead><tbody>{rows.map((row) => <tr key={row.day_index} className="border-b border-slate-200"><td className="p-2">{dayLabels[row.day_index - 1]}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.calendar_days)}</td><td className="p-2 text-right tabular-nums">{averageOrDash(row.average_flights)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.min_flights)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.max_flights)}</td></tr>)}</tbody></table></div>
      </details>
    </article>
  );
}

export function FleetMixChart({ rows }: { rows: FleetMixRow[] }) {
  const visibleRows = rows.filter((row) => !row.suppressed && row.share != null && row.flights != null);
  const ariaSummary = visibleRows.length === 0
    ? 'Cơ cấu nhóm tàu bay chưa đủ dữ liệu công bố.'
    : visibleRows.map((row) => `${row.label} ${percentFormat.format((row.share ?? 0) * 100)} phần trăm`).join(', ');
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-bold text-blue-900">Loại tàu bay</p>
      <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">Cơ cấu nhóm tàu bay</h3>
      <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">So sánh tỷ trọng số chuyến giữa các nhóm tàu bay trong phạm vi đang chọn. Mở từng nhóm để xem các loại tàu bay khi dữ liệu có sẵn.</p>
      {visibleRows.length > 0 ? <>
        <div className="mt-6 flex h-10 overflow-hidden rounded-xl bg-slate-100" role="img" aria-label={ariaSummary}>
          {visibleRows.map((row, index) => <span key={row.key} className="block h-full border-r-2 border-white last:border-r-0" style={{ width: `${(row.share ?? 0) * 100}%`, backgroundColor: fleetColors[index % fleetColors.length] }} />)}
        </div>
        <ul className="mt-5 grid items-start gap-3 sm:grid-cols-2">{visibleRows.map((row, index) => {
          const children = row.children?.filter((child) => !child.suppressed && child.flights != null) ?? [];
          const summary = <span className="flex min-h-11 w-full items-center justify-between gap-4 py-2"><span className="inline-flex min-w-0 items-center gap-3"><span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: fleetColors[index % fleetColors.length] }} /><span className="truncate font-semibold text-slate-700" title={row.label} aria-label={row.label}>{row.label}</span></span><span className="shrink-0 text-right text-sm font-bold tabular-nums text-[#102033]">{numberFormat.format(row.flights ?? 0)} · {percentFormat.format((row.share ?? 0) * 100)}%</span></span>;
          return <li key={row.key} className="rounded-xl border border-slate-200 px-3">
            {children.length > 0 ? <details>
              <summary className="report-focus cursor-pointer rounded-sm">{summary}</summary>
              <div className="border-t border-slate-200 py-3">
                <p className="text-xs font-semibold text-slate-500">Các loại tàu bay trong nhóm</p>
                <dl className="mt-2 space-y-2">{children.map((child) => <div key={child.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-lg bg-slate-50 px-3 py-2 text-sm"><dt className="truncate font-semibold text-slate-700" title={child.label} aria-label={child.label}>{child.label}</dt><dd className="text-right font-bold tabular-nums text-slate-900">{numberFormat.format(child.flights ?? 0)} chuyến</dd>{child.reported_pax != null ? <><dt className="text-xs text-slate-500">Sản lượng khách</dt><dd className="text-right text-xs tabular-nums text-slate-600">{numberFormat.format(child.reported_pax)}</dd></> : null}</div>)}</dl>
              </div>
            </details> : summary}
          </li>;
        })}</ul>
      </> : <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"><p className="font-semibold">Chưa có dữ liệu nhóm tàu bay trong phạm vi đang chọn.</p><p className="mt-1 text-pretty text-slate-600">Hãy chọn khoảng ngày hoặc bộ lọc khác.</p></div>}
      {rows.some((row) => row.suppressed) ? <p className="mt-4 text-xs leading-5 text-slate-500">Một số nhóm chưa có số liệu để hiển thị.</p> : null}
    </article>
  );
}
