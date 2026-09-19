import { cn } from '@/lib/cn';
import type { TrafficMonthlyDayOfWeekRow, TrafficType } from '@/lib/trafficReportContract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const dayLabels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];

function valueForScope(row: TrafficMonthlyDayOfWeekRow, scope: TrafficType): number | null {
  if (scope === 'A') return row.average_arrivals;
  if (scope === 'D') return row.average_departures;
  return row.average_flights;
}

function isPeakForScope(row: TrafficMonthlyDayOfWeekRow, scope: TrafficType): boolean {
  if (scope === 'A') return row.is_peak_arrivals;
  if (scope === 'D') return row.is_peak_departures;
  return row.is_peak_all;
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

export function TrafficMonthlyDayOfWeekHeatmap({ rows, scope }: { rows: TrafficMonthlyDayOfWeekRow[]; scope: TrafficType }) {
  const months = [...new Set(rows.map((row) => row.month))];
  const maxValue = Math.max(1, ...rows.flatMap((row) => {
    const value = valueForScope(row, scope);
    return value == null ? [] : [value];
  }));
  return <section className="mt-6 border-t border-slate-200 pt-6" aria-labelledby="weekday-heatmap-title">
    <h4 id="weekday-heatmap-title" className="text-balance text-lg font-bold text-slate-950">Breakdown Thứ trong tuần theo tháng</h4>
    <p className="mt-1 text-pretty text-sm leading-6 text-slate-600">Mỗi ô là trung bình số chuyến của Thứ đó trong tháng, tính trên ngày hoàn chỉnh và làm tròn số nguyên.</p>
    <div className="report-focus mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-slate-200" role="region" tabIndex={0} aria-label="Ma trận trung bình chuyến bay theo tháng và Thứ trong tuần">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead><tr className="bg-slate-100 text-slate-700"><th className="border-b border-r border-slate-200 p-3 text-left">Tháng</th>{dayLabels.map((label) => <th key={label} className="border-b border-slate-200 p-3 text-center">{label}</th>)}</tr></thead>
        <tbody>{months.map((month) => {
          const monthRows = rows.filter((row) => row.month === month).sort((left, right) => left.day_index - right.day_index);
          return <tr key={month} className="border-b border-slate-100"><th className="border-r border-slate-200 p-3 text-left font-bold text-slate-800 tabular-nums">Tháng {Number(month.slice(5))}/{month.slice(0, 4)}</th>{monthRows.map((row) => {
            const value = valueForScope(row, scope);
            const isPeak = isPeakForScope(row, scope);
            const coverageLabel = row.complete_day_count === row.selected_day_count
              ? `${row.complete_day_count} ngày hoàn chỉnh`
              : `${row.complete_day_count}/${row.selected_day_count} ngày hoàn chỉnh`;
            return <td key={row.day_index} className="p-2 text-center"><span
              className={cn('inline-flex min-h-12 min-w-14 flex-col items-center justify-center rounded-lg px-2 font-bold tabular-nums', heatClass(value, maxValue), isPeak && 'ring-2 ring-amber-500 ring-offset-2')}
              title={`${dayLabels[row.day_index - 1]}, ${coverageLabel}${isPeak ? ', cao nhất tháng' : ''}`}
            ><span>{value == null ? '—' : numberFormat.format(value)}</span>{isPeak ? <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wide">Cao nhất</span> : null}</span></td>;
          })}</tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}
