import type { TrafficBreakdownRow, TrafficDayOfWeekRow, TrafficPeakHourRow, TrafficTimeBasis } from '@/lib/trafficReportContract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const decimalFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dayLabels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
const fleetColors = ['#234093', '#00b4d8', '#526274', '#42c1c7'];
const referenceCapacity = 14;

function valueOrDash(value: number | null): string {
  return value == null ? '—' : numberFormat.format(value);
}

function averagePerDay(value: number | null, dayCount: number): number | null {
  return value == null || dayCount <= 0 ? null : value / dayCount;
}

export function PeakHourChart({ rows, dayCount, timeBasis, onTimeBasisChange }: {
  rows: TrafficPeakHourRow[];
  dayCount: number;
  timeBasis: TrafficTimeBasis;
  onTimeBasisChange: (basis: TrafficTimeBasis) => void;
}) {
  const averages = rows.map((row) => ({
    ...row,
    averageArrivals: averagePerDay(row.arrivals, dayCount),
    averageDepartures: averagePerDay(row.departures, dayCount),
  }));
  const maxAverage = Math.max(referenceCapacity, ...averages.map((row) => (row.averageArrivals ?? 0) + (row.averageDepartures ?? 0)), 1);
  const capacityPosition = (referenceCapacity / maxAverage) * 100;
  const peak = [...averages]
    .filter((row) => !row.suppressed)
    .sort((left, right) => ((right.averageArrivals ?? 0) + (right.averageDepartures ?? 0)) - ((left.averageArrivals ?? 0) + (left.averageDepartures ?? 0)))[0];

  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase text-[#234093]">Peak-hour distribution</p>
          <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">24 khung giờ khai thác</h3>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-slate-600">Trung bình chuyến trên mỗi ngày trong kỳ. {peak ? `Khung giờ cao nhất hiện là ${peak.hour_bucket}.` : 'Chưa đủ dữ liệu công bố khung giờ cao nhất.'}</p>
        </div>
        <fieldset className="flex gap-2">
          <legend className="sr-only">Múi giờ biểu đồ khung giờ</legend>
          {(['local', 'utc'] as const).map((basis) => <button
            key={basis}
            className={timeBasis === basis ? 'report-focus min-h-11 rounded-full bg-[#234093] px-4 text-sm font-bold text-white' : 'report-focus min-h-11 rounded-full border border-slate-300 bg-white px-4 text-sm font-bold text-[#234093]'}
            type="button"
            aria-pressed={timeBasis === basis}
            onClick={() => onTimeBasisChange(basis)}
          >{basis === 'local' ? 'Giờ địa phương' : 'UTC'}</button>)}
        </fieldset>
      </div>

      <div className="mt-6 overflow-x-auto pb-2">
        <div className="relative flex h-72 min-w-[720px] items-end gap-1 border-b border-slate-300 px-2 pt-6" aria-hidden="true">
          <div className="pointer-events-none absolute inset-x-2 border-t-2 border-dashed border-amber-600" style={{ bottom: `${capacityPosition}%` }}>
            <span className="absolute right-0 -translate-y-full bg-white px-1 text-xs font-semibold text-amber-800">14 chuyến/giờ</span>
          </div>
          {averages.map((row, index) => {
            const arrival = row.averageArrivals ?? 0;
            const departure = row.averageDepartures ?? 0;
            const total = arrival + departure;
            const totalHeight = (total / maxAverage) * 100;
            const arrivalShare = total === 0 ? 0 : (arrival / total) * 100;
            return <div key={row.hour_bucket} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              {row.suppressed ? <div className="mb-1 flex min-h-8 items-center justify-center rounded-t border border-dashed border-amber-600 bg-amber-50 text-[10px] font-bold text-amber-800">Ẩn</div> : <div className="flex min-h-px flex-col-reverse overflow-hidden rounded-t" style={{ height: `${totalHeight}%` }}>
                <span className="block bg-[#234093]" style={{ height: `${arrivalShare}%` }} />
                <span className="block bg-[#42c1c7]" style={{ height: `${100 - arrivalShare}%` }} />
              </div>}
              <span className="mt-2 text-center text-[10px] font-semibold text-slate-500">{index % 3 === 0 ? row.hour_bucket.slice(0, 2) : ''}</span>
            </div>;
          })}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold text-slate-600"><span className="inline-flex items-center gap-2"><span className="h-2 w-5 rounded bg-[#234093]" />ARR</span><span className="inline-flex items-center gap-2"><span className="h-2 w-5 rounded bg-[#42c1c7]" />DEP</span><span className="inline-flex items-center gap-2"><span className="w-5 border-t-2 border-dashed border-amber-600" />Mốc tham chiếu</span></div>
      <p className="mt-3 text-pretty text-xs leading-5 text-slate-500">Mốc 14 chuyến/giờ chỉ là tham chiếu trực quan, chưa phải capacity được phê duyệt cho nhà ga hoặc sân đỗ.</p>

      <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-[#234093]">Bảng dữ liệu 24 khung giờ</summary>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="border-b border-slate-300"><th className="p-2">Giờ</th><th className="p-2 text-right">ARR TB/ngày</th><th className="p-2 text-right">DEP TB/ngày</th><th className="p-2">Trạng thái</th></tr></thead><tbody>{averages.map((row) => <tr key={row.hour_bucket} className="border-b border-slate-200"><td className="p-2 tabular-nums">{row.hour_bucket}</td><td className="p-2 text-right tabular-nums">{row.averageArrivals == null ? '—' : decimalFormat.format(row.averageArrivals)}</td><td className="p-2 text-right tabular-nums">{row.averageDepartures == null ? '—' : decimalFormat.format(row.averageDepartures)}</td><td className="p-2">{row.suppressed ? 'Đã ẩn' : 'Công bố'}</td></tr>)}</tbody></table></div>
      </details>
    </article>
  );
}

export function DayOfWeekChart({ rows }: { rows: TrafficDayOfWeekRow[] }) {
  const maxValue = Math.max(1, ...rows.map((row) => row.max_flights ?? 0));
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-bold uppercase text-[#234093]">Weekly operating pattern</p>
      <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">Chu kỳ Thứ trong tuần</h3>
      <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">Chiều cao cột là số chuyến trung bình; vạch dọc biểu diễn khoảng Min–Max của từng Thứ trong kỳ.</p>
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
                <span className="absolute inset-x-0 text-xs font-bold tabular-nums text-[#102033]" style={{ bottom: `${Math.min(96, (average / maxValue) * 100 + 2)}%` }}>{decimalFormat.format(average)}</span>
              </> : <span className="absolute inset-x-0 bottom-2 rounded border border-dashed border-amber-600 bg-amber-50 py-2 text-[10px] font-bold text-amber-800">Ẩn</span>}
            </div>
            <span className="mt-2 min-h-9 text-xs font-semibold text-slate-600">{dayLabels[row.day_index - 1]}</span>
          </div>;
        })}
      </div>
      <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="report-focus cursor-pointer rounded-sm font-semibold text-[#234093]">Bảng dữ liệu theo Thứ</summary>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-slate-300"><th className="p-2">Thứ</th><th className="p-2 text-right">Số ngày</th><th className="p-2 text-right">TB chuyến</th><th className="p-2 text-right">Min</th><th className="p-2 text-right">Max</th><th className="p-2">Trạng thái</th></tr></thead><tbody>{rows.map((row) => <tr key={row.day_index} className="border-b border-slate-200"><td className="p-2">{dayLabels[row.day_index - 1]}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.calendar_days)}</td><td className="p-2 text-right tabular-nums">{row.average_flights == null ? '—' : decimalFormat.format(row.average_flights)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.min_flights)}</td><td className="p-2 text-right tabular-nums">{valueOrDash(row.max_flights)}</td><td className="p-2">{row.suppressed ? 'Đã ẩn' : 'Công bố'}</td></tr>)}</tbody></table></div>
      </details>
    </article>
  );
}

export function FleetMixChart({ rows }: { rows: TrafficBreakdownRow[] }) {
  const visibleRows = rows.filter((row) => !row.suppressed && row.share != null && row.flights != null);
  const ariaSummary = visibleRows.length === 0
    ? 'Cơ cấu nhóm tàu bay chưa đủ dữ liệu công bố.'
    : visibleRows.map((row) => `${row.label} ${decimalFormat.format((row.share ?? 0) * 100)} phần trăm`).join(', ');
  return (
    <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-bold uppercase text-[#234093]">Fleet and stand pressure</p>
      <h3 className="mt-2 text-balance text-2xl font-bold text-[#102033]">Cơ cấu nhóm tàu bay</h3>
      <p className="mt-2 text-pretty text-sm leading-6 text-slate-600">Giữ nguyên phân nhóm từ database hiện tại; chưa suy diễn seat configuration hoặc mã stand từ tên nhóm tàu bay.</p>
      {visibleRows.length > 0 ? <>
        <div className="mt-6 flex h-10 overflow-hidden rounded-xl bg-slate-100" role="img" aria-label={ariaSummary}>
          {visibleRows.map((row, index) => <span key={row.key} className="block h-full border-r-2 border-white last:border-r-0" style={{ width: `${(row.share ?? 0) * 100}%`, backgroundColor: fleetColors[index % fleetColors.length] }} />)}
        </div>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">{visibleRows.map((row, index) => <li key={row.key} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-3"><span className="inline-flex min-w-0 items-center gap-3"><span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: fleetColors[index % fleetColors.length] }} /><span className="truncate font-semibold text-slate-700">{row.label}</span></span><span className="text-right text-sm font-bold tabular-nums text-[#102033]">{numberFormat.format(row.flights ?? 0)} · {decimalFormat.format((row.share ?? 0) * 100)}%</span></li>)}</ul>
      </> : <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Chưa đủ cohort để công bố cơ cấu nhóm tàu bay.</p>}
      {rows.some((row) => row.suppressed) ? <p className="mt-4 text-xs leading-5 text-slate-500">Có nhóm được ẩn theo ngưỡng bảo vệ dữ liệu nhỏ và không được nội suy vào phần còn lại.</p> : null}
    </article>
  );
}
