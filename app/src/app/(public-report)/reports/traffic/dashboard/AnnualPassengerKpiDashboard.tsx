'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type SVGProps,
} from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CartesianGrid,
  Label,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/cn';
import {
  ANNUAL_KPI_API_BASE,
  ANNUAL_KPI_VERSION_POLL_MS,
  DASHBOARD_DAILY_PUBLICATION_ENABLED,
  annualDashboardPublicationUrl,
  annualDashboardPublicationVersionUrl,
  annualKpiSnapshotUrl,
  annualKpiVersionUrl,
  currentHcmYear,
  decodeAnnualPassengerDashboardSnapshot,
  isAnnualPassengerKpiSnapshot,
  parseAnnualKpiYear,
  type AnnualKpiConfig,
  type AnnualKpiStatus,
  type AnnualPassengerKpiSnapshot,
} from '@/lib/annualPassengerKpiContract';
import { mockAnnualPassengerKpiSnapshot } from '@/lib/annualPassengerKpiMock';

const numberFormat = new Intl.NumberFormat('vi-VN');
const decimalFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const millionFormat = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
});
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'Asia/Ho_Chi_Minh',
});

function displayNumber(value: number | null | undefined): string {
  return value == null ? '—' : numberFormat.format(value);
}

function displayDecimal(value: number | null | undefined, suffix = ''): string {
  return value == null ? '—' : `${decimalFormat.format(value)}${suffix}`;
}

function displayMillions(value: number | null | undefined): string {
  return value == null ? '—' : `${millionFormat.format(value)}M`;
}

function displayDate(value: string | null | undefined): string {
  if (!value) return '—';
  return dateFormat.format(new Date(`${value}T00:00:00+07:00`));
}

function displayDayMonth(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return '—';
  return `${value.slice(8, 10)}/${value.slice(5, 7)}`;
}

function dayOfYear(year: number, isoDate: string | null | undefined): number | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)) return null;
  const time = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  const day = Math.floor((time - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  return day >= 1 && day <= 366 ? day : null;
}

function monthLabelForDay(year: number, day: number | string): string {
  const date = new Date(Date.UTC(year, 0, Number(day)));
  return `T${date.getUTCMonth() + 1}`;
}
function DayDot({ x, y }: { x?: number | string; y?: number | string }) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return <circle cx={x} cy={y - 5} r={1.2} fill="#cbd5e1" />;
}

function displayUpdated(value: string | null | undefined): string {
  if (!value) return '—';
  const parts = dateTimeFormat.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} · ${part('day')}/${part('month')}/${part('year')}`;
}

function forecastBasisNote(snapshot: AnnualPassengerKpiSnapshot): string {
  if (snapshot.period_state === 'past') return 'Kết quả kỳ KPI đã kết thúc';
  if (snapshot.forecast_method === 'rolling_completed_ops_dates_30'
    && snapshot.forecast_window_days != null
    && snapshot.forecast_average_reported_pax_per_day != null) {
    return `Theo TB ${displayNumber(snapshot.forecast_window_days)} ngày gần nhất: ${displayNumber(Math.round(snapshot.forecast_average_reported_pax_per_day))} khách/ngày`;
  }
  return 'Theo trung bình luỹ kế năm hiện tại';
}

function statusLabel(status: AnnualKpiStatus): string {
  return ({
    unknown: 'Chưa đủ dữ liệu',
    not_started: 'Chưa bắt đầu',
    not_achieved: 'Chưa đạt chỉ tiêu',
    at_risk: 'Có nguy cơ không đạt',
    on_track: 'Đúng tiến độ',
    ahead: 'Vượt tiến độ',
    achieved: 'Đã đạt chỉ tiêu',
    exceeded: 'Đã vượt chỉ tiêu',
  } as const)[status];
}

function statusTone(status: AnnualKpiStatus): 'amber' | 'cyan' | 'emerald' | 'muted' {
  if (['ahead', 'achieved', 'exceeded'].includes(status)) return 'emerald';
  if (status === 'on_track') return 'cyan';
  if (['at_risk', 'not_achieved'].includes(status)) return 'amber';
  return 'muted';
}

function IconBase({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}

function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z" /><path d="M7 13h3M14 13h3M7 17h3" /></IconBase>;
}

function UsersIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></IconBase>;
}

function TrendIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="m3 17 6-6 4 4 8-8" /><path d="M14 7h7v7" /></IconBase>;
}

function ArrivalIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M2 16h20M6 12 3 9l1-1 5 2 3-7 2 1-1 8 5 2c2 .8 3 2 3 2H7" /></IconBase>;
}

function DepartureIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M2 16h20M5 12l4-2-1-7 2-1 3 6 5-2c2-.8 3 0 3 0s-1 2-3 3l-5 3-6 1-2-1Z" /></IconBase>;
}

function StatusIcon({ tone, ...props }: SVGProps<SVGSVGElement> & { tone: ReturnType<typeof statusTone> }) {
  if (tone === 'muted') return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 17h.01" /></IconBase>;
  return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></IconBase>;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  note,
  accent = 'cyan',
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
  note: string;
  accent?: 'cyan' | 'amber' | 'emerald';
}) {
  const tones = {
    cyan: 'bg-sky-50 text-sky-700 ring-sky-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  };
  return (
    <article className="metric-card">
      <div className={cn('metric-icon grid size-11 place-items-center rounded-lg ring-1', tones[accent])}><Icon className="size-5" /></div>
      <div className="min-w-0">
        <p className="metric-label">{label}</p>
        <p className="metric-value mt-1 text-[clamp(1.75rem,2.6vw,2.6rem)] font-bold leading-none text-slate-950 tabular-nums">{value}</p>
        <p className="metric-note mt-1.5 truncate text-sm text-slate-600">{note}</p>
      </div>
    </article>
  );
}

function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div className="kpi-progress-track" role="img" aria-label={percent == null ? 'Chưa đủ dữ liệu để tính tỷ lệ hoàn thành' : `Đã hoàn thành ${displayDecimal(percent, '%')} KPI năm`}>
      {percent == null ? <span className="kpi-progress-missing" /> : <span className="kpi-progress-value" style={{ transform: `scaleX(${Math.max(0, Math.min(percent, 100)) / 100})` }} />}
    </div>
  );
}

function CompletionRing({ percent }: { percent: number | null }) {
  const safePercent = Math.max(0, Math.min(percent ?? 0, 100));
  return (
    <div className={cn('completion-ring', percent == null && 'completion-ring-missing')} style={{ '--progress': `${safePercent * 3.6}deg` } as CSSProperties} role="img" aria-label={percent == null ? 'Chưa đủ dữ liệu để tính tỷ lệ hoàn thành' : `Đã hoàn thành ${displayDecimal(percent, '%')}`}>
      <div><span>{percent == null ? '—' : `${Math.round(percent)}%`}</span><small>hoàn thành</small></div>
    </div>
  );
}

type TrendPoint = { day: number; month: string; actual: number | null; target: number | null; projection: number | null };

function buildTrend(snapshot: AnnualPassengerKpiSnapshot): { points: TrendPoint[]; periodMonth: number; daysInYear: number; monthEnds: number[] } {
  const periodMonth = snapshot.period_to ? Number(snapshot.period_to.slice(5, 7)) : 1;
  const daysInYear = new Date(Date.UTC(snapshot.year, 1, 29)).getUTCDate() === 29 ? 366 : 365;
  const periodDay = dayOfYear(snapshot.year, snapshot.period_to);
  const monthly = new Map(snapshot.monthly.map((item) => [Number(item.month.slice(5)), item]));
  let cumulative = 0;
  let cumulativeComplete = true;
  const monthEnds: number[] = [];
  const points = Array.from({ length: 12 }, (_, index): TrendPoint => {
    const month = index + 1;
    const item = monthly.get(month);
    let actual: number | null = null;
    if (month <= periodMonth && item?.reported_pax != null && cumulativeComplete) {
      cumulative += item.reported_pax;
      actual = cumulative / 1_000_000;
    } else if (month <= periodMonth) {
      cumulativeComplete = false;
      if (month === periodMonth && snapshot.reported_pax != null) actual = snapshot.reported_pax / 1_000_000;
    }
    const endOfMonth = new Date(Date.UTC(snapshot.year, month, 0));
    const startOfYear = Date.UTC(snapshot.year, 0, 1);
    const elapsedDays = Math.floor((endOfMonth.getTime() - startOfYear) / 86_400_000) + 1;
    monthEnds.push(elapsedDays);
    // The current month is only complete through period_to: anchor its point at
    // the exact day so the actual line ends on the reference line, not month-end.
    const day = month === periodMonth && periodDay != null ? periodDay : elapsedDays;
    const target = snapshot.target_reported_pax == null ? null : snapshot.target_reported_pax * day / daysInYear / 1_000_000;
    let projection: number | null = null;
    if (snapshot.forecast_reported_pax != null && snapshot.reported_pax != null && month >= periodMonth) {
      if (periodDay != null && daysInYear > periodDay) {
        const ratio = Math.max(0, day - periodDay) / (daysInYear - periodDay);
        projection = (snapshot.reported_pax + (snapshot.forecast_reported_pax - snapshot.reported_pax) * ratio) / 1_000_000;
      } else if (periodDay == null) {
        const remainingMonths = Math.max(1, 12 - periodMonth);
        const ratio = Math.max(0, month - periodMonth) / remainingMonths;
        projection = (snapshot.reported_pax + (snapshot.forecast_reported_pax - snapshot.reported_pax) * ratio) / 1_000_000;
      }
    }
    return { day, month: `T${month}`, actual, target, projection };
  });
  return { points, periodMonth, daysInYear, monthEnds };
}

function TrendChart({ snapshot, wallboard }: { snapshot: AnnualPassengerKpiSnapshot; wallboard: boolean }) {
  const { points, periodMonth, daysInYear, monthEnds } = useMemo(() => buildTrend(snapshot), [snapshot]);
  const maximum = Math.max(1, ...points.flatMap((point) => [point.actual ?? 0, point.target ?? 0, point.projection ?? 0]));
  const yAxisMax = Math.max(2.5, Math.ceil(maximum * 2) / 2 + 0.5);
  const yAxisStep = yAxisMax <= 4.5 ? 1 : 2;
  const yAxisTicks = Array.from({ length: Math.floor(yAxisMax / yAxisStep) + 1 }, (_, index) => index * yAxisStep);
  const actualEnd = points[Math.max(0, periodMonth - 1)]?.actual ?? null;
  const targetEnd = points[points.length - 1]?.target ?? null;
  const projectionEnd = points[points.length - 1]?.projection ?? null;
  const forecastGap = snapshot.forecast_pct == null ? null : snapshot.forecast_pct - 100;
  const monthTicks = monthEnds;
  const dayTicks = Array.from({ length: daysInYear }, (_, index) => index + 1);
  const periodDay = dayOfYear(snapshot.year, snapshot.period_to);
  return (
    <article className="chart-panel" aria-labelledby="trend-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="metric-label">Xu hướng tích lũy</p><h2 id="trend-title" className="trend-title mt-1 text-balance text-lg font-semibold text-slate-950 sm:text-xl">Sản lượng khách so với tiến độ KPI</h2></div>
        <span className={cn('trend-forecast flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm font-medium ring-1', forecastGap == null ? 'bg-slate-100 text-slate-700 ring-slate-200' : forecastGap < -2 ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200')}>
          <TrendIcon className="size-4" /> {forecastGap == null ? 'Chưa đủ dữ liệu dự báo' : `Dự báo ${forecastGap >= 0 ? '+' : ''}${displayDecimal(forecastGap, '%')}`}
        </span>
      </div>
      <div className="kpi-trend-chart mt-3" role="img" aria-label="Biểu đồ sản lượng khách tích lũy so với tiến độ KPI">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={wallboard ? 0 : 190}>
          <LineChart data={points} margin={{ top: 12, right: 18, left: -8, bottom: 2 }}>
            <CartesianGrid vertical={false} stroke="#cbd5e1" strokeWidth={1.2} />
            <XAxis dataKey="day" type="number" domain={[1, daysInYear]} ticks={monthTicks} tickFormatter={(day) => monthLabelForDay(snapshot.year, day)} tickLine={false} axisLine={false} tickMargin={wallboard ? 14 : 10} stroke="#334155" fontSize={wallboard ? 20 : 15} fontWeight={wallboard ? 600 : 500} />
            <XAxis xAxisId="days" dataKey="day" type="number" domain={[1, daysInYear]} ticks={dayTicks} interval={0} tickFormatter={() => ''} tickLine={false} axisLine={false} height={12} tick={<DayDot />} />
            <YAxis domain={[0, yAxisMax]} ticks={yAxisTicks} interval={0} tickFormatter={(value) => `${value}M`} tickLine={false} axisLine={false} width={wallboard ? 72 : 56} stroke="#334155" fontSize={wallboard ? 20 : 15} fontWeight={wallboard ? 600 : 500} />
            <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 12, color: '#0f172a' }} labelStyle={{ color: '#0f172a', fontWeight: 650 }} itemStyle={{ color: '#0f172a' }} labelFormatter={(day) => monthLabelForDay(snapshot.year, day)} formatter={(value, name) => [`${Number(value).toFixed(2).replace('.', ',')} triệu`, name === 'actual' ? 'Đã đạt' : name === 'projection' ? 'Dự báo luỹ kế năm' : 'Tiến độ cần đạt']} />
            <Legend verticalAlign="top" align="center" height={wallboard ? 40 : 32} formatter={(value) => value === 'actual' ? 'Đã đạt' : value === 'projection' ? 'Dự báo luỹ kế năm' : 'Tiến độ cần đạt'} wrapperStyle={{ fontSize: wallboard ? 20 : 15, fontWeight: 600, color: '#334155' }} />
            {periodDay != null ? <ReferenceLine x={periodDay} stroke="#64748b" strokeWidth={wallboard ? 2.5 : 1.5} strokeDasharray="8 6" label={{ value: `Ngày số liệu mới nhất: ${displayDayMonth(snapshot.period_to)}`, position: 'insideTopRight', fill: '#334155', fontSize: wallboard ? 16 : 12, fontWeight: 650 }} /> : null}
            <Line dataKey="actual" type="monotone" stroke="#0369a1" strokeWidth={wallboard ? 6 : 3.5} dot={{ r: wallboard ? 5.5 : 3, fill: '#0369a1', stroke: '#ffffff', strokeWidth: wallboard ? 2 : 1 }} activeDot={{ r: wallboard ? 8 : 5 }} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="target" type="monotone" stroke="#334155" strokeWidth={wallboard ? 5 : 2.5} strokeDasharray="4 8" dot={false} isAnimationActive={false} />
            <Line dataKey="projection" type="monotone" stroke="#c2410c" strokeWidth={wallboard ? 5 : 3} strokeDasharray="16 8" dot={false} connectNulls={false} isAnimationActive={false} />
            {wallboard && actualEnd != null && periodDay != null ? (
              <ReferenceDot x={periodDay} y={actualEnd} r={6} fill="#0369a1" stroke="#ffffff" strokeWidth={2}>
                <Label value={`Đã đạt ${displayMillions(actualEnd)}`} position="bottom" offset={16} fill="#075985" fontSize={18} fontWeight={700} stroke="#f8fafc" strokeWidth={4} paintOrder="stroke" />
              </ReferenceDot>
            ) : null}
            {wallboard && projectionEnd != null ? (
              <ReferenceDot x={daysInYear} y={projectionEnd} r={6} fill="#c2410c" stroke="#ffffff" strokeWidth={2}>
                <Label value={`Dự báo ${displayMillions(projectionEnd)}`} position="left" offset={14} dy={-12} fill="#9a3412" fontSize={18} fontWeight={700} stroke="#f8fafc" strokeWidth={4} paintOrder="stroke" />
              </ReferenceDot>
            ) : null}
            {wallboard && targetEnd != null ? (
              <ReferenceDot x={daysInYear} y={targetEnd} r={6} fill="#334155" stroke="#ffffff" strokeWidth={2}>
                <Label value={`KPI ${displayMillions(targetEnd)}`} position="left" offset={14} dy={14} fill="#1e293b" fontSize={18} fontWeight={700} stroke="#f8fafc" strokeWidth={4} paintOrder="stroke" />
              </ReferenceDot>
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

function KpiAdminDialog({
  dialogRef,
  snapshot,
  onSaved,
  automaticYear,
  autoYear,
  availableYears,
  onSelectYear,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  snapshot: AnnualPassengerKpiSnapshot | null;
  onSaved: (nextSnapshot: AnnualPassengerKpiSnapshot) => void | Promise<void>;
  automaticYear: number;
  autoYear: boolean;
  availableYears: number[];
  onSelectYear: (value: string) => void;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState('');
  const [configs, setConfigs] = useState<AnnualKpiConfig[]>([]);
  const [year, setYear] = useState(snapshot?.year ?? currentHcmYear());
  const [target, setTarget] = useState(snapshot?.target_reported_pax ? String(snapshot.target_reported_pax) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectedConfig = configs.find((item) => item.year === year) ?? null;
  const close = () => dialogRef.current?.close();
  const loadConfigs = useCallback(async () => {
    const response = await fetch(`${ANNUAL_KPI_API_BASE}/kpi-config`, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    const payload = await response.json().catch(() => null) as { items?: AnnualKpiConfig[]; error?: string } | null;
    if (!response.ok || !payload || !Array.isArray(payload.items)) throw new Error(payload?.error ?? 'Không thể tải cấu hình KPI.');
    setConfigs(payload.items);
    const current = payload.items.find((item) => item.year === year);
    if (current) setTarget(String(current.target_reported_pax));
  }, [year]);
  const unlock = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`${ANNUAL_KPI_API_BASE}/kpi-admin/unlock`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ pin }) });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'Không thể mở trình chỉnh sửa KPI.');
      setPin(''); setUnlocked(true); await loadConfigs();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Không thể mở trình chỉnh sửa KPI.'); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const numericTarget = Number(target.replaceAll('.', '').replaceAll(',', ''));
    if (!Number.isSafeInteger(numericTarget) || numericTarget <= 0) { setError('KPI phải là số nguyên lớn hơn 0.'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`${ANNUAL_KPI_API_BASE}/kpi-admin/${year}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ target_reported_pax: numericTarget }) });
      const payload = await response.json().catch(() => null) as { config?: AnnualKpiConfig; snapshot?: unknown; error?: string } | null;
      if (!response.ok) { if (response.status === 401) setUnlocked(false); throw new Error(payload?.error ?? 'Không thể lưu KPI.'); }
      const savedConfig = payload?.config;
      if (!savedConfig || savedConfig.year !== year || !Number.isSafeInteger(savedConfig.target_reported_pax) || savedConfig.target_reported_pax <= 0 || !isAnnualPassengerKpiSnapshot(payload.snapshot)) throw new Error('Máy chủ chưa trả về đầy đủ KPI vừa lưu.');
      setConfigs((current) => [...current.filter((item) => item.year !== savedConfig.year), savedConfig].sort((left, right) => left.year - right.year));
      setTarget(String(savedConfig.target_reported_pax));
      setMessage(`Đã lưu KPI năm ${year}.`);
      await onSaved(payload.snapshot);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Không thể lưu KPI.'); }
    finally { setBusy(false); }
  };
  const lock = async () => {
    setBusy(true); await fetch(`${ANNUAL_KPI_API_BASE}/kpi-admin/lock`, { method: 'POST', credentials: 'include' }).catch(() => null);
    setBusy(false); setUnlocked(false); setPin(''); setError(null); setMessage(null); close();
  };
  return (
    <dialog ref={dialogRef} className="kpi-admin-dialog m-auto rounded-2xl border border-white/10 bg-[#0b1729] p-0 text-white shadow-2xl" aria-labelledby="kpi-admin-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="metric-label text-cyan-300">Quản trị nội bộ</p><h2 id="kpi-admin-title" className="mt-2 text-balance text-xl font-semibold">Điều chỉnh KPI năm</h2></div><button className="report-focus min-h-11 rounded-lg px-4 text-sm font-semibold text-slate-300 hover:bg-slate-800" type="button" onClick={close}>Đóng</button></div>
        <label className="kpi-admin-year-control mt-5 block text-sm font-semibold text-slate-200">
          Năm dashboard đang xem
          <select aria-label="Năm dashboard đang xem" value={autoYear ? 'auto' : String(snapshot?.year ?? automaticYear)} onChange={(event) => onSelectYear(event.target.value)}>
            <option value="auto">Tự động ({automaticYear})</option>
            {availableYears.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {!unlocked ? (
          <form className="mt-6" onSubmit={unlock}>
            <label className="block text-sm font-semibold text-slate-200">PIN quản trị<input autoFocus className="report-focus mt-2 min-h-12 w-full rounded-lg border border-slate-600 bg-slate-950/50 px-4 text-lg text-white" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(event) => setPin(event.target.value)} required /></label>
            {error ? <p className="mt-3 text-sm font-semibold text-rose-300" role="alert">{error}</p> : null}
            <button className="report-focus mt-5 min-h-12 w-full rounded-lg bg-cyan-300 px-5 font-bold text-slate-950 disabled:opacity-50" type="submit" disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Mở trình chỉnh sửa'}</button>
          </form>
        ) : (
          <form className="mt-6 space-y-5" onSubmit={save}>
            <label className="block text-sm font-semibold text-slate-200">Năm KPI<input className="report-focus mt-2 min-h-12 w-full rounded-lg border border-slate-600 bg-slate-950/50 px-4 text-lg tabular-nums text-white" type="number" min="2000" max="2200" value={year} onChange={(event) => { const nextYear = Number(event.target.value); setYear(nextYear); const config = configs.find((item) => item.year === nextYear); setTarget(config ? String(config.target_reported_pax) : ''); }} required /></label>
            <label className="block text-sm font-semibold text-slate-200">KPI sản lượng khách năm<input className="report-focus mt-2 min-h-12 w-full rounded-lg border border-slate-600 bg-slate-950/50 px-4 text-lg tabular-nums text-white" type="text" inputMode="numeric" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Ví dụ: 7500000" required /></label>
            <div className="rounded-lg bg-slate-950/45 p-4 text-sm text-slate-300"><p>Giá trị đang áp dụng: <strong className="tabular-nums text-white">{displayNumber(selectedConfig?.target_reported_pax)}</strong></p><p className="mt-1">Cập nhật gần nhất: {displayUpdated(selectedConfig?.updated_at)}</p></div>
            {error ? <p className="text-sm font-semibold text-rose-300" role="alert">{error}</p> : null}{message ? <p className="text-sm font-semibold text-emerald-300" role="status">{message}</p> : null}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"><button className="report-focus min-h-12 rounded-lg border border-slate-600 px-5 font-semibold text-slate-200" type="button" disabled={busy} onClick={() => void lock()}>Khóa</button><button className="report-focus min-h-12 rounded-lg bg-cyan-300 px-6 font-bold text-slate-950 disabled:opacity-50" type="submit" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu KPI'}</button></div>
          </form>
        )}
      </div>
    </dialog>
  );
}

function DashboardSkeleton() {
  return <div className="grid gap-3" role="status" aria-label="Đang tải dashboard"><div className="hero-grid"><div className="hero-panel animate-pulse" /><div className="status-panel min-h-72 animate-pulse" /></div><div className="metrics-grid">{[1, 2, 3].map((item) => <div key={item} className="metric-card h-24 animate-pulse" />)}</div><div className="chart-panel h-64 animate-pulse" /></div>;
}

export default function AnnualPassengerKpiDashboard() {
  const searchParams = useSearchParams();
  const selectedYear = parseAnnualKpiYear(searchParams.get('year'));
  const requestedView = searchParams.get('view');
  const wallboard = requestedView !== 'standard';
  const [automaticYear, setAutomaticYear] = useState(() => currentHcmYear());
  const year = selectedYear ?? automaticYear;
  const autoYear = selectedYear == null;
  const [snapshot, setSnapshot] = useState<AnnualPassengerKpiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const versionEtagRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const loadSnapshot = useCallback(async (selected: number, clear = false) => {
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    setLoading(true); setError(null); if (clear) setSnapshot(null);
    try {
      const snapshotUrl = DASHBOARD_DAILY_PUBLICATION_ENABLED
        ? annualDashboardPublicationUrl(selected)
        : annualKpiSnapshotUrl(selected);
      const versionUrl = DASHBOARD_DAILY_PUBLICATION_ENABLED
        ? annualDashboardPublicationVersionUrl(selected)
        : annualKpiVersionUrl(selected);
      const response = await fetch(snapshotUrl, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      const decoded = decodeAnnualPassengerDashboardSnapshot(payload);
      if (!response.ok || !decoded) { const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : 'Dashboard tạm thời chưa thể cập nhật.'; throw new Error(message); }
      setSnapshot(decoded);
      const versionResponse = await fetch(versionUrl, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (versionResponse.ok) versionEtagRef.current = versionResponse.headers.get('ETag');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const fallback = mockAnnualPassengerKpiSnapshot(selected);
      if (fallback) { setSnapshot(fallback); setError(null); }
      else setError(caught instanceof Error ? caught.message : 'Dashboard tạm thời chưa thể cập nhật.');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  const checkVersion = useCallback(async () => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (versionEtagRef.current) headers['If-None-Match'] = versionEtagRef.current;
    const versionUrl = DASHBOARD_DAILY_PUBLICATION_ENABLED
      ? annualDashboardPublicationVersionUrl(year)
      : annualKpiVersionUrl(year);
    const response = await fetch(versionUrl, { cache: 'no-store', credentials: 'omit', headers }).catch(() => null);
    if (!response || response.status === 304 || !response.ok) return;
    const nextEtag = response.headers.get('ETag');
    if (!versionEtagRef.current || nextEtag !== versionEtagRef.current) { versionEtagRef.current = nextEtag; await loadSnapshot(year); }
  }, [loadSnapshot, year]);
  useEffect(() => { versionEtagRef.current = null; const task = window.setTimeout(() => void loadSnapshot(year, true), 0); return () => { window.clearTimeout(task); requestRef.current?.abort(); }; }, [loadSnapshot, year]);
  useEffect(() => { const interval = window.setInterval(() => void checkVersion(), ANNUAL_KPI_VERSION_POLL_MS); return () => window.clearInterval(interval); }, [checkVersion]);
  useEffect(() => {
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void checkVersion(); };
    const refreshWhenOnline = () => void checkVersion();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('online', refreshWhenOnline);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenOnline);
    };
  }, [checkVersion]);
  useEffect(() => { const interval = window.setInterval(() => { const current = currentHcmYear(); if (autoYear && current !== year) setAutomaticYear(current); }, 60_000); return () => window.clearInterval(interval); }, [autoYear, year]);

  const availableYears = useMemo(() => { const current = currentHcmYear(); return Array.from(new Set([current - 2, current - 1, current, current + 1, current + 2, year])).sort((left, right) => left - right); }, [year]);
  const selectYear = (value: string) => { const nextParams = new URLSearchParams(searchParams.toString()); if (value === 'auto') nextParams.delete('year'); else nextParams.set('year', value); const query = nextParams.toString(); window.location.assign(`${window.location.pathname}${query ? `?${query}` : ''}`); };

  const target = snapshot?.target_reported_pax ?? null;
  const reported = snapshot?.reported_pax ?? null;
  const remaining = target == null || reported == null ? null : Math.max(target - reported, 0);
  const exceeded = target == null || reported == null ? null : Math.max(reported - target, 0);
  const exceededPct = exceeded == null || target == null || target === 0 ? null : exceeded * 100 / target;
  const completion = snapshot?.completion_pct ?? null;
  const tone = statusTone(snapshot?.status ?? 'unknown');
  const mainMessage = !snapshot ? 'Đang tải số liệu…' : target == null ? `Chưa cấu hình KPI năm ${snapshot.year}.` : snapshot.period_state === 'future' ? 'Chưa bắt đầu kỳ KPI.' : snapshot.period_state === 'past' ? snapshot.status === 'exceeded' ? <>Đã vượt chỉ tiêu <strong className="text-sky-700 tabular-nums">{displayNumber(exceeded)} khách (vượt {displayDecimal(exceededPct, '%')}).</strong></> : snapshot.status === 'achieved' ? 'Đã đạt chỉ tiêu năm.' : <>Kết quả cuối năm: <strong className="text-sky-700 tabular-nums">{displayNumber(reported)} khách.</strong></> : snapshot.status === 'exceeded' ? <>Đã vượt chỉ tiêu <strong className="text-sky-700 tabular-nums">{displayNumber(exceeded)} khách (vượt {displayDecimal(exceededPct, '%')}).</strong></> : snapshot.status === 'achieved' ? 'Đã đạt chỉ tiêu năm.' : !snapshot.data_ready ? <>Hôm nay cần phục vụ tối thiểu <strong className="text-sky-700 tabular-nums">— khách · Chưa đủ dữ liệu</strong></> : <>Hôm nay cần phục vụ tối thiểu <strong className="text-sky-700 tabular-nums">{displayNumber(snapshot.required_reported_pax_today)} khách.</strong></>;

  return (
    <main className={cn('kpi-dashboard min-h-dvh text-foreground lg:h-dvh lg:overflow-hidden', wallboard && 'kpi-wallboard')}>
      <button className="report-focus fixed left-0 top-0 z-40 size-11 rounded-md opacity-0 focus-visible:opacity-100" type="button" aria-label="Mở trình chỉnh sửa KPI" onClick={() => dialogRef.current?.showModal()} />
      <div className="dashboard-shell">
        <header className="dashboard-header relative flex min-h-11 items-center justify-between gap-3 border-b border-slate-200 py-2">
          <h1 className="dashboard-title min-w-0 truncate text-balance text-base font-semibold text-slate-950 sm:text-lg">KPI sản lượng khách năm {year}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <span className="snapshot-meta hidden items-center gap-1.5 text-xs font-medium text-slate-600 lg:flex">{snapshot?.publication ? `Ngày số liệu ${displayDate(snapshot.publication.business_date)} · ` : ''}Cập nhật lúc {displayUpdated(snapshot?.projection.refreshed_at)}</span>
            <span className={cn('freshness-badge hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium sm:flex', snapshot?.projection.projection_status === 'fresh' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800')} aria-live="polite"><span aria-hidden="true" className={cn('size-2 rounded-full', snapshot?.projection.projection_status === 'fresh' ? 'bg-emerald-600' : 'bg-amber-600')} />{loading && snapshot ? 'Đang cập nhật' : snapshot?.projection.projection_status === 'fresh' ? 'Dữ liệu mới nhất' : 'Bản cập nhật gần nhất'}</span>
          </div>
        </header>

        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-pretty text-sm text-rose-900" role="alert"><strong>Không thể cập nhật dashboard.</strong> {error}<button className="report-focus ml-3 min-h-10 rounded-lg border border-rose-300 px-3 font-semibold" type="button" onClick={() => void loadSnapshot(year)}>Thử lại</button></div> : null}
        {loading && !snapshot ? <DashboardSkeleton /> : null}

        {snapshot ? <>
          <section className="hero-grid" aria-labelledby="countdown-title">
            <article className="hero-panel relative overflow-hidden">
              <div className="hero-content relative flex h-full flex-col justify-between gap-6">
                <div>
                  <div className="hero-context mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-slate-600"><span className="rounded-full bg-slate-100 px-3 py-1.5 ring-1 ring-slate-200">Năm dương lịch</span>{snapshot.period_to ? <span className="px-1.5 text-slate-500">Đến hết {displayDate(snapshot.period_to)}</span> : null}</div>
                  <p id="countdown-title" className="hero-message max-w-[28ch] text-balance text-[clamp(2rem,3.8vw,4rem)] font-semibold leading-[1.08] text-slate-950">{mainMessage}</p>
                  <p className="hero-note mt-3 max-w-2xl text-pretty text-base leading-relaxed text-slate-600 sm:text-lg">{target == null ? 'KPI năm này chưa được thiết lập.' : reported == null ? 'Chưa có số liệu sản lượng khách cho kỳ KPI.' : reported < target ? <>Còn thiếu <strong className="font-semibold text-slate-900 tabular-nums">{displayNumber(remaining)} khách</strong> để đạt KPI năm.</> : <>Đã đạt <strong className="font-semibold text-slate-900 tabular-nums">{displayNumber(reported)} khách</strong> trong năm.</>}</p>
                </div>
                <div><div className="mb-2.5 flex items-end justify-between gap-4"><div><p className="metric-label">Đã đạt / KPI năm</p><p className="hero-progress-value mt-1 text-2xl font-semibold text-slate-950 tabular-nums">{displayNumber(reported)} <span className="font-normal text-slate-400">/</span> {displayNumber(target)}</p></div><p className="hero-progress-percent text-4xl font-bold text-sky-700 tabular-nums">{displayDecimal(completion, '%')}</p></div><ProgressBar percent={completion} /></div>
              </div>
            </article>

            <article className="status-panel">
              <div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="status-heading text-base font-semibold uppercase text-slate-600">Đánh giá tiến độ</p><div className={cn('status-value mt-3 flex items-center gap-2.5', tone === 'amber' ? 'text-amber-700' : tone === 'cyan' ? 'text-sky-700' : tone === 'emerald' ? 'text-emerald-700' : 'text-slate-600')}><StatusIcon tone={tone} className="size-9" /><p className="text-4xl font-semibold leading-none">{statusLabel(snapshot.status)}</p></div></div><CompletionRing percent={completion} /></div>
              <div className="mt-auto grid grid-cols-2 gap-3"><div className="soft-stat"><ArrivalIcon className="size-6 text-sky-700" /><p className="soft-stat-label mt-3 text-base font-semibold uppercase text-slate-600">Khách đến</p><p className="soft-stat-value mt-1.5 text-4xl font-bold text-slate-950 tabular-nums">{displayNumber(snapshot.arrival_reported_pax)}</p></div><div className="soft-stat"><DepartureIcon className="size-6 text-slate-700" /><p className="soft-stat-label mt-3 text-base font-semibold uppercase text-slate-600">Khách đi</p><p className="soft-stat-value mt-1.5 text-4xl font-bold text-slate-950 tabular-nums">{displayNumber(snapshot.departure_reported_pax)}</p></div></div>
            </article>
          </section>

          <section className="metrics-grid" aria-label="Các chỉ số tiến độ">
            <MetricCard icon={CalendarIcon} label="Ngày còn lại" value={snapshot.period_state === 'current' ? displayNumber(snapshot.remaining_days) : '—'} note={snapshot.period_state === 'future' ? 'Chưa bắt đầu kỳ KPI' : snapshot.period_state === 'past' ? 'Kỳ KPI đã kết thúc' : 'Tính từ hôm nay đến 31/12'} />
            <MetricCard icon={UsersIcon} label="Trung bình thực tế / ngày" value={displayNumber(snapshot.average_reported_pax_per_day == null ? null : Math.round(snapshot.average_reported_pax_per_day))} note={snapshot.elapsed_days > 0 ? `${displayNumber(snapshot.elapsed_days)} ngày đã hoàn tất` : 'Chưa có ngày hoàn tất'} accent="emerald" />
            <MetricCard icon={TrendIcon} label="Dự báo cuối năm" value={displayNumber(snapshot.forecast_reported_pax)} note={forecastBasisNote(snapshot)} accent="amber" />
          </section>

          <section className="bottom-grid"><TrendChart snapshot={snapshot} wallboard={wallboard} /></section>
          <footer className="dashboard-footer flex items-center justify-between gap-4 border-t py-2 text-[10px] uppercase"><span>Dashboard KPI sản lượng khách năm</span><span className="lg:hidden">Cập nhật lúc {displayUpdated(snapshot.projection.refreshed_at)}</span><span className="hidden lg:inline">Cập nhật khi có dữ liệu mới</span></footer>
        </> : null}
      </div>
      <KpiAdminDialog
        dialogRef={dialogRef}
        snapshot={snapshot}
        onSaved={(nextSnapshot) => {
          versionEtagRef.current = null;
          if (DASHBOARD_DAILY_PUBLICATION_ENABLED) void loadSnapshot(year);
          else setSnapshot(nextSnapshot);
        }}
        automaticYear={automaticYear}
        autoYear={autoYear}
        availableYears={availableYears}
        onSelectYear={selectYear}
      />
    </main>
  );
}
