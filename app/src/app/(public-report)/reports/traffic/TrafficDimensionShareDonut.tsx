import type { TrafficDimensionShareResponse } from '@/lib/trafficReportV2Contract';

const numberFormat = new Intl.NumberFormat('vi-VN');
const percentFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const colors = ['#1e3a8a', '#0369a1', '#0e7490', '#0f766e', '#15803d', '#a16207', '#c2410c', '#be123c', '#7e22ce', '#4338ca'];

function formatPercent(value: number): string {
  return `${percentFormat.format(value * 100)}%`;
}

export function TrafficDimensionShareDonut({
  title,
  data,
  loading,
  error,
  onRetry,
}: {
  title: string;
  data: TrafficDimensionShareResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const rows = data ? [...data.top_rows, ...(data.other ? [data.other] : [])] : [];
  let offset = 0;
  const metricLabel = data?.metric === 'reported_pax' ? 'khách đã ghi nhận' : 'chuyến bay';

  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-label={title}>
      <h4 className="text-balance text-base font-bold text-slate-950">{title}</h4>
      {data?.metric === 'reported_pax' ? <p className="mt-1 text-pretty text-xs leading-5 text-slate-600">Tính trên dữ liệu hành khách đã ghi nhận.</p> : null}

      {loading ? <div className="mt-4 grid gap-4 sm:grid-cols-[11rem_1fr]" role="status"><div className="mx-auto size-40 animate-pulse rounded-full bg-slate-200" /><div className="space-y-2">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-5 animate-pulse rounded bg-slate-200" />)}</div><span className="sr-only">Đang tải {title.toLocaleLowerCase('vi-VN')}</span></div> : null}
      {error ? <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" role="alert"><p className="font-semibold">Không thể tải biểu đồ</p><p className="mt-1">{error}</p><button className="report-focus mt-3 min-h-11 rounded-lg bg-rose-800 px-4 font-bold text-white focus-visible:outline-blue-900 focus-visible:ring-2 focus-visible:ring-blue-900 focus-visible:ring-offset-2" type="button" onClick={onRetry}>Thử lại</button></div> : null}
      {!loading && !error && (!data || data.total_value == null || data.total_value <= 0 || rows.length === 0) ? <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700"><p className="font-semibold">Chưa có dữ liệu để thể hiện tỷ trọng.</p><p className="mt-1">Hãy chọn phạm vi hoặc bộ lọc khác.</p></div> : null}

      {!loading && !error && data && data.total_value != null && data.total_value > 0 && rows.length > 0 ? <div className="mt-4 grid items-start gap-5 lg:grid-cols-[12rem_1fr]">
        <div className="relative mx-auto size-48">
          <svg viewBox="0 0 120 120" className="size-48" role="img" aria-label={`${title}. Tổng ${numberFormat.format(data.total_value)} ${metricLabel}.`}>
            <circle cx="60" cy="60" r="45" fill="none" stroke="#e2e8f0" strokeWidth="18" />
            {rows.map((row, index) => {
              const start = offset;
              offset += row.share * 100;
              return <circle
                key={`${row.key ?? row.label}-${index}`}
                cx="60"
                cy="60"
                r="45"
                fill="none"
                pathLength="100"
                stroke={row.label === 'Khác' ? '#94a3b8' : colors[index % colors.length]}
                strokeWidth="18"
                strokeDasharray={`${Math.max(0, row.share * 100)} ${Math.max(0, 100 - row.share * 100)}`}
                strokeDashoffset={-start}
                strokeLinecap="butt"
                transform="rotate(-90 60 60)"
              ><title>{`${row.label}: ${numberFormat.format(row.value)} ${metricLabel}, ${formatPercent(row.share)}`}</title></circle>;
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <strong className="max-w-28 text-lg font-bold tabular-nums text-slate-950">{numberFormat.format(data.total_value)}</strong>
            <span className="max-w-24 text-pretty text-xs text-slate-600">{metricLabel}</span>
          </div>
        </div>
        <ol className="grid gap-x-4 gap-y-2 sm:grid-cols-2" aria-label={`Chú thích ${title.toLocaleLowerCase('vi-VN')}`}>
          {rows.map((row, index) => <li key={`${row.key ?? row.label}-legend-${index}`} className="flex min-w-0 items-start gap-2 text-xs text-slate-700">
            <span className="mt-1 size-3 shrink-0 rounded-sm border border-white shadow-sm" style={{ backgroundColor: row.label === 'Khác' ? '#94a3b8' : colors[index % colors.length] }} aria-hidden="true" />
            <span className="min-w-0"><span className="block font-semibold text-slate-900 break-words text-pretty" title={row.label}>{row.label}</span><span className="tabular-nums">{numberFormat.format(row.value)} · {formatPercent(row.share)}</span></span>
          </li>)}
        </ol>
      </div> : null}
    </section>
  );
}
