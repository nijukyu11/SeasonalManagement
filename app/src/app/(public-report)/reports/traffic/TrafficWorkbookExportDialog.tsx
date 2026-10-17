'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { cn } from '@/lib/cn';
import { buildTrafficHtmlExportUrl } from '@/lib/trafficHtmlExportContract';
import type { NormalizedTrafficReportFilter } from '@/lib/trafficReportContract';
import {
  buildTrafficWorkbookExportUrl,
  getTrafficComparisonYearRange,
  getTrafficMonthRange,
  getTrafficMonthRangeRange,
  getTrafficSeasonOptions,
  getTrafficWeeklyContextRange,
  getTrafficWorkbookDownloadName,
  getTrafficYearRange,
  normalizeTrafficWorkbookExportDraft,
  type TrafficWorkbookComparison,
  type TrafficWorkbookExportDraft,
  type TrafficWorkbookReportType,
} from '@/lib/trafficWorkbookExportContract';

type ExportStage = 'idle' | 'normalizing' | 'capturing' | 'rendering' | 'done';

const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const enabledReportTypes = new Set((process.env.NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const reportTypeOrder: TrafficWorkbookReportType[] = ['MASTER_OPERATIONS', 'MONTHLY_OVERVIEW_L2', 'WEEKLY_DETAIL', 'PERIOD_ANALYSIS', 'BAO_CAO_SAN_LUONG'];
const htmlEnabled = process.env.NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED === 'true';

function formatDate(value: string): string {
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function DownloadIcon() {
  return <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

function initialDraft(filter: NormalizedTrafficReportFilter): TrafficWorkbookExportDraft {
  const month = filter.to.slice(0, 7);
  const reportType = reportTypeOrder.find((value) => enabledReportTypes.size === 0 || enabledReportTypes.has(value)) ?? 'MASTER_OPERATIONS';
  return {
    reportType,
    periodMode: reportType === 'MONTHLY_OVERVIEW_L2' ? 'month' : reportType === 'BAO_CAO_SAN_LUONG' ? 'season' : 'custom',
    seasonCode: '',
    month,
    monthFrom: month,
    monthTo: month,
    year: month.slice(0, 4),
    from: filter.from,
    to: filter.to,
    comparisons: ['WEEKLY_DETAIL', 'PERIOD_ANALYSIS', 'BAO_CAO_SAN_LUONG'].includes(reportType) ? [] : ['previous', 'year_ago'],
    comparisonYears: [],
    timeBasis: filter.tz,
  };
}

export function TrafficWorkbookExportDialog({ filter, minOpsDate, maxOpsDate }: {
  filter: NormalizedTrafficReportFilter;
  minOpsDate: string;
  maxOpsDate: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => initialDraft(filter));
  const [stage, setStage] = useState<ExportStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<'xlsx' | 'html'>('html');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [comparisonCatalog, setComparisonCatalog] = useState<Array<{ year: number; label: string; from: string; to: string; available: boolean }> | null>(null);
  const [comparisonCatalogLoading, setComparisonCatalogLoading] = useState(false);
  const [comparisonCatalogError, setComparisonCatalogError] = useState<string | null>(null);
  const seasons = useMemo(() => getTrafficSeasonOptions(minOpsDate, maxOpsDate), [minOpsDate, maxOpsDate]);
  const exporting = !['idle', 'done'].includes(stage);

  const open = () => {
    const next = initialDraft(filter);
    next.seasonCode = seasons.find((season) => season.from <= filter.from && season.to >= filter.to)?.code ?? seasons.at(-1)?.code ?? '';
    setDraft(next);
    setOutput('html');
    setStage('idle');
    setError(null);
    setCompareEnabled(false);
    setComparisonCatalog(null);
    setComparisonCatalogError(null);
    dialogRef.current?.showModal();
  };

  const close = () => {
    if (exporting) return;
    setError(null);
    dialogRef.current?.close();
  };

  const updateReportType = (reportType: TrafficWorkbookReportType) => {
    setDraft((current) => ({
      ...current,
      reportType,
      periodMode: reportType === 'MONTHLY_OVERVIEW_L2'
        ? 'month'
        : reportType === 'BAO_CAO_SAN_LUONG'
          ? 'season'
          : 'custom',
      comparisons: ['WEEKLY_DETAIL', 'PERIOD_ANALYSIS', 'BAO_CAO_SAN_LUONG'].includes(reportType) ? [] : current.comparisons.length ? current.comparisons : ['previous', 'year_ago'],
      comparisonYears: [],
    }));
    setCompareEnabled(false);
    setComparisonCatalog(null);
    setComparisonCatalogError(null);
    setError(null);
  };

  const toggleComparison = (comparison: TrafficWorkbookComparison) => {
    setDraft((current) => ({
      ...current,
      comparisons: current.comparisons.includes(comparison)
        ? current.comparisons.filter((candidate) => candidate !== comparison)
        : [...current.comparisons, comparison],
    }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStage('normalizing');
    setError(null);
    try {
      const request = normalizeTrafficWorkbookExportDraft(draft, filter, minOpsDate, maxOpsDate);
      setStage('capturing');
      const response = await fetch(output === 'html' ? buildTrafficHtmlExportUrl(request) : buildTrafficWorkbookExportUrl(request), {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: output === 'html' ? 'text/html' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      });
      setStage('rendering');
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(payload?.error ? String(payload.error) : 'Chưa thể tạo workbook.');
      }
      const blob = await response.blob();
      const fallback = request.reportType === 'MASTER_OPERATIONS'
        ? 'workbook-tong-hop-khai-thac.xlsx'
        : request.reportType === 'MONTHLY_OVERVIEW_L2'
          ? `tong-quan-khai-thac-${request.period.month}.xlsx`
          : request.reportType === 'WEEKLY_DETAIL'
            ? `chi-tiet-khai-thac-tuan-${request.period.from}-${request.period.to}.xlsx`
            : request.reportType === 'PERIOD_ANALYSIS'
              ? `phan-tich-theo-ky-${request.period.from}-${request.period.to}.xlsx`
              : `bao-cao-san-luong-${request.period.seasonCode}.xlsx`;
      const filename = getTrafficWorkbookDownloadName(response.headers.get('Content-Disposition'), output === 'html' ? fallback.replace(/\.xlsx$/u, '.html') : fallback);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setStage('done');
    } catch (reason) {
      setStage('idle');
      setError(reason instanceof Error ? reason.message : 'Không thể tạo workbook.');
    }
  };

  const selectedSeason = seasons.find((season) => season.code === draft.seasonCode);
  const selectedMonth = (() => {
    try { return getTrafficMonthRange(draft.month); } catch { return null; }
  })();
  const resolvedRange = (() => {
    try {
      if (draft.periodMode === 'season') return selectedSeason ?? null;
      if (draft.periodMode === 'month') return selectedMonth;
      if (draft.periodMode === 'month_range') return getTrafficMonthRangeRange(draft.monthFrom, draft.monthTo);
      if (draft.periodMode === 'year') return getTrafficYearRange(draft.year);
      return { from: draft.from, to: draft.to };
    } catch { return null; }
  })();
  const derivedComparisonOptions = useMemo(() => {
    if (draft.reportType !== 'PERIOD_ANALYSIS' || !resolvedRange) return [];
    const result: Array<{ year: number; label: string; from: string; to: string; available: boolean }> = [];
    const minYear = Number(minOpsDate.slice(0, 4));
    const maxYear = Number(maxOpsDate.slice(0, 4));
    for (let year = maxYear; year >= minYear; year -= 1) {
      try {
        const option = getTrafficComparisonYearRange({ periodMode: draft.periodMode, from: resolvedRange.from, to: resolvedRange.to, seasonCode: draft.seasonCode, comparisonYear: year });
        if (option.from === resolvedRange.from && option.to === resolvedRange.to) continue;
        if (option.to < minOpsDate || option.from > maxOpsDate) continue;
        result.push({ year, ...option, available: option.from >= minOpsDate && option.to <= maxOpsDate });
      } catch { /* Bỏ option không resolve được. */ }
    }
    return result;
  }, [draft.periodMode, draft.reportType, draft.seasonCode, maxOpsDate, minOpsDate, resolvedRange]);
  const comparisonOptions = (comparisonCatalog ?? derivedComparisonOptions).filter(option => output !== 'html' || option.year < Number(resolvedRange?.from.slice(0, 4)));
  const loadComparisonOptions = async () => {
    setComparisonCatalogLoading(true);
    setComparisonCatalogError(null);
    try {
      const request = normalizeTrafficWorkbookExportDraft({ ...draft, comparisonYears: [] }, filter, minOpsDate, maxOpsDate);
      const url = buildTrafficWorkbookExportUrl(request).replace('/workbook-export?', '/workbook-period-options?');
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('Không thể tải danh sách cùng kỳ.');
      const payload = await response.json() as { comparison_periods?: Array<{ comparison_year: number; label: string; from: string; to: string; selectable: boolean }> };
      setComparisonCatalog((payload.comparison_periods ?? []).map((option) => ({ year: option.comparison_year, label: option.label, from: option.from, to: option.to, available: option.selectable })));
    } catch (reason) {
      setComparisonCatalog(null);
      setComparisonCatalogError(reason instanceof Error ? reason.message : 'Không thể tải danh sách cùng kỳ.');
    } finally {
      setComparisonCatalogLoading(false);
    }
  };
  const stageLabel = stage === 'normalizing'
    ? 'Đang chuẩn bị báo cáo…'
    : stage === 'capturing'
      ? 'Đang tổng hợp dữ liệu…'
      : stage === 'rendering'
        ? 'Đang hoàn tất báo cáo…'
        : stage === 'done'
          ? 'Đã tải báo cáo.'
          : null;

  return (
    <>
      <button className="report-focus inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-bold text-white hover:bg-blue-950" type="button" onClick={open}>
        <DownloadIcon />
        Xuất báo cáo
      </button>
      <dialog
        ref={dialogRef}
        className="report-filter-dialog m-0 max-h-[88dvh] w-full max-w-none overflow-hidden rounded-t-2xl bg-white p-0 text-slate-900 shadow-xl md:m-auto md:max-w-3xl md:rounded-2xl"
        aria-labelledby="traffic-workbook-export-title"
        onCancel={(event) => { event.preventDefault(); close(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      >
        <form className="flex max-h-[88dvh] flex-col" onSubmit={submit}>
          <header className="flex min-h-16 items-center justify-between border-b border-slate-200 px-4 sm:px-6">
            <div>
              <h2 id="traffic-workbook-export-title" className="text-balance text-lg font-bold">Xuất báo cáo</h2>
              <p className="text-pretty text-xs text-slate-600">Chọn loại báo cáo và kỳ dữ liệu cần tải.</p>
            </div>
            <button className="report-focus flex size-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-50" type="button" aria-label="Đóng hộp thoại xuất báo cáo" disabled={exporting} onClick={close}><CloseIcon /></button>
          </header>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
            {htmlEnabled ? <fieldset disabled={exporting}>
              <legend className="text-sm font-bold">Định dạng</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold"><input className="report-focus" type="radio" name="output-format" checked={output === 'html'} onChange={() => { setOutput('html'); setDraft(current => ({ ...current, comparisonYears: current.comparisonYears.filter(year => year < Number(resolvedRange?.from.slice(0, 4))) })); }} />HTML offline (.html)</label>
              </div>
              {output === 'html' ? <p className="mt-2 text-pretty text-sm text-slate-600">Một file đọc được khi không có mạng; bung nhóm, lọc và in ngay trong trình duyệt. File chứa toàn bộ dữ liệu tổng hợp trong phạm vi đã xuất.</p> : null}
            </fieldset> : null}
            <fieldset>
              <legend className="text-sm font-bold text-slate-900">Loại báo cáo</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {([
                  ['MASTER_OPERATIONS', 'Workbook tổng hợp khai thác', '12 sheet tổng hợp theo thời gian, thị trường, giờ và tàu bay.'],
                  ['MONTHLY_OVERVIEW_L2', 'Tổng quan khai thác tháng - Mức 2', output === 'html' ? 'Chuyến bay và hành khách Đến/Đi/Tổng; so sánh tháng và phân tích hãng, thị trường, chặng ảnh hưởng.' : '9 sheet phục vụ lập báo cáo tháng, có MoM, YoY và hai biểu đồ.'],
                  ['WEEKLY_DETAIL', 'Báo cáo tuần chi tiết', '8 sheet; tự động kèm 7 ngày trước và 7 ngày sau kỳ đã chọn.'],
                  ['PERIOD_ANALYSIS', 'Phân tích theo kỳ', '7 sheet; chọn tháng, nhiều tháng, mùa, năm hoặc khoảng ngày và nhiều năm cùng kỳ.'],
                  ['BAO_CAO_SAN_LUONG', 'Báo cáo sản lượng theo mẫu', '11 sheet theo bố cục BaoCaoSanLuong.'],
                ] as const).filter(([value]) => enabledReportTypes.size === 0 || enabledReportTypes.has(value)).map(([value, label, description]) => <label key={value} className={cn('cursor-pointer rounded-xl border p-4', draft.reportType === value ? 'border-blue-800 bg-blue-50' : 'border-slate-300 bg-white')}>
                  <input className="report-focus mr-2" type="radio" name="report-type" value={value} checked={draft.reportType === value} onChange={() => updateReportType(value)} />
                  <span className="font-bold text-blue-950">{label}</span>
                  <span className="mt-1 block text-pretty text-xs leading-5 text-slate-600">{output === 'html' ? value === 'WEEKLY_DETAIL' ? 'Bảng tương tác với kỳ chọn, 7 ngày trước và 7 ngày sau.' : value === 'BAO_CAO_SAN_LUONG' ? 'Tổng hợp, tuần, tháng và hai bảng Analysis.' : 'Bảng tương tác theo thời gian, hãng, thị trường, chặng, tàu bay, giờ và tần suất.' : description}</span>
                </label>)}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-sm font-bold text-slate-900">Kỳ báo cáo</legend>
              {output === 'html' ? <p className="mt-2 text-pretty text-sm text-slate-600">Chọn khoảng ngày, tháng, năm hoặc mùa tại đây theo loại báo cáo. File đã tải giữ cố định kỳ này và các kỳ đối chiếu đã chọn; muốn đổi kỳ, hãy xuất file mới.</p> : null}
              {draft.reportType === 'PERIOD_ANALYSIS' ? <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {([['month', 'Một tháng'], ['month_range', 'Nhiều tháng'], ['season', 'Cả mùa'], ['year', 'Cả năm'], ['custom', 'Khoảng ngày']] as const).map(([mode, label]) => <label key={mode} className="text-sm font-semibold"><input className="report-focus mr-2" type="radio" name="period-mode" checked={draft.periodMode === mode} onChange={() => { setDraft((current) => ({ ...current, periodMode: mode, comparisonYears: [] })); setCompareEnabled(false); }} />{label}</label>)}
              </div> : draft.reportType === 'MASTER_OPERATIONS' ? <div className="mt-2 flex flex-wrap gap-4">
                <label className="text-sm font-semibold"><input className="report-focus mr-2" type="radio" name="period-mode" checked={draft.periodMode === 'season'} onChange={() => setDraft((current) => ({ ...current, periodMode: 'season' }))} />Cả mùa</label>
                <label className="text-sm font-semibold"><input className="report-focus mr-2" type="radio" name="period-mode" checked={draft.periodMode === 'custom'} onChange={() => setDraft((current) => ({ ...current, periodMode: 'custom' }))} />Khoảng ngày tùy chỉnh</label>
              </div> : draft.reportType === 'WEEKLY_DETAIL' ? <p className="mt-2 text-pretty text-sm text-slate-600">Chọn kỳ trọng tâm. Workbook sẽ lấy thêm đúng 7 ngày liền trước và 7 ngày liền sau.</p> : null}

              {draft.periodMode === 'season' ? <label className="mt-4 block text-sm font-semibold text-slate-700">Mùa khai thác
                <select className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base" value={draft.seasonCode} onChange={(event) => setDraft((current) => ({ ...current, seasonCode: event.target.value, comparisonYears: [] }))} required>
                  {seasons.map((season) => <option key={season.code} value={season.code}>{season.code} · {formatDate(season.from)}–{formatDate(season.to)}</option>)}
                </select>
              </label> : draft.periodMode === 'month' ? <label className="mt-4 block text-sm font-semibold text-slate-700">Tháng báo cáo
                <input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="month" min={minOpsDate.slice(0, 7)} max={maxOpsDate.slice(0, 7)} value={draft.month} onChange={(event) => setDraft((current) => ({ ...current, month: event.target.value, comparisonYears: [] }))} required />
              </label> : draft.periodMode === 'month_range' ? <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-slate-700">Từ tháng<input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="month" min={minOpsDate.slice(0, 7)} max={maxOpsDate.slice(0, 7)} value={draft.monthFrom} onChange={(event) => setDraft((current) => ({ ...current, monthFrom: event.target.value, comparisonYears: [] }))} required /></label>
                <label className="text-sm font-semibold text-slate-700">Đến tháng<input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="month" min={minOpsDate.slice(0, 7)} max={maxOpsDate.slice(0, 7)} value={draft.monthTo} onChange={(event) => setDraft((current) => ({ ...current, monthTo: event.target.value, comparisonYears: [] }))} required /></label>
              </div> : draft.periodMode === 'year' ? <label className="mt-4 block text-sm font-semibold text-slate-700">Năm báo cáo
                <input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="number" min={minOpsDate.slice(0, 4)} max={maxOpsDate.slice(0, 4)} value={draft.year} onChange={(event) => setDraft((current) => ({ ...current, year: event.target.value, comparisonYears: [] }))} required />
              </label> : <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-slate-700">Từ ngày<input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="date" min={minOpsDate} max={maxOpsDate} value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value, comparisonYears: [] }))} required /></label>
                <label className="text-sm font-semibold text-slate-700">Đến ngày<input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="date" min={minOpsDate} max={maxOpsDate} value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value, comparisonYears: [] }))} required /></label>
              </div>}
            </fieldset>

            {resolvedRange ? <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700"><span className="font-bold">Khoảng ngày báo cáo:</span> <span className="tabular-nums">{formatDate(resolvedRange.from)}–{formatDate(resolvedRange.to)}</span></div> : null}

            {draft.reportType === 'WEEKLY_DETAIL' ? (() => {
              try {
                const context = getTrafficWeeklyContextRange(draft.from, draft.to);
                return <div className="grid gap-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 sm:grid-cols-3">
                  <span><strong>Tuần trước:</strong> <span className="tabular-nums">{formatDate(context.previous.from)}–{formatDate(context.previous.to)}</span></span>
                  <span><strong>Kỳ đã chọn:</strong> <span className="tabular-nums">{formatDate(context.selected.from)}–{formatDate(context.selected.to)}</span></span>
                  <span><strong>Tuần sau:</strong> <span className="tabular-nums">{formatDate(context.next.from)}–{formatDate(context.next.to)}</span></span>
                </div>;
              } catch { return null; }
            })() : draft.reportType === 'PERIOD_ANALYSIS' ? <fieldset>
              <legend className="text-sm font-bold text-slate-900">So sánh cùng kỳ</legend>
              <label className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold"><input className="report-focus mr-2" type="checkbox" checked={compareEnabled} onChange={(event) => { const enabled = event.target.checked; setCompareEnabled(enabled); if (enabled) void loadComparisonOptions(); else { setDraft((current) => ({ ...current, comparisonYears: [] })); setComparisonCatalog(null); setComparisonCatalogError(null); } }} />So sánh với cùng kỳ trong quá khứ</label>
              {compareEnabled ? <div className="mt-3 rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Chọn năm so sánh ({draft.comparisonYears.length} đã chọn)</p>
                  <div className="flex gap-2">
                    <button className="report-focus min-h-11 rounded-lg px-3 text-sm font-bold text-blue-900 hover:bg-blue-50" type="button" onClick={() => setDraft((current) => ({ ...current, comparisonYears: comparisonOptions.filter((option) => option.available).map((option) => option.year) }))}>Chọn tất cả</button>
                    <button className="report-focus min-h-11 rounded-lg px-3 text-sm font-bold text-slate-700 hover:bg-slate-100" type="button" onClick={() => setDraft((current) => ({ ...current, comparisonYears: [] }))}>Bỏ chọn</button>
                  </div>
                </div>
                {comparisonCatalogLoading ? <p className="mt-2 text-sm font-semibold text-cyan-900" role="status">Đang tải danh sách cùng kỳ…</p> : comparisonCatalogError ? <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" role="alert"><p>{comparisonCatalogError}</p><button className="report-focus mt-2 min-h-11 rounded-lg px-3 font-bold hover:bg-rose-100" type="button" onClick={() => void loadComparisonOptions()}>Thử lại</button></div> : comparisonOptions.length ? <div className="mt-2 max-h-56 space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {comparisonOptions.map((option) => <label key={option.year} className={cn('flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm', option.available ? 'cursor-pointer border-slate-200' : 'cursor-not-allowed border-amber-200 bg-amber-50 text-slate-600')}>
                    <input className="report-focus mt-0.5" type="checkbox" disabled={!option.available} checked={draft.comparisonYears.includes(option.year)} onChange={() => setDraft((current) => ({ ...current, comparisonYears: current.comparisonYears.includes(option.year) ? current.comparisonYears.filter((year) => year !== option.year) : [...current.comparisonYears, option.year] }))} />
                    <span className="min-w-0 flex-1"><strong>{option.label}</strong><span className="block tabular-nums text-xs">{formatDate(option.from)}–{formatDate(option.to)}</span></span>
                    <span className={cn('rounded-full px-2 py-1 text-xs font-bold', option.available ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900')}>{option.available ? 'Đủ dữ liệu' : 'Thiếu dữ liệu'}</span>
                  </label>)}
                </div> : <p className="mt-2 text-sm text-slate-600">Không có cùng kỳ nào trong phạm vi dữ liệu hiện có.</p>}
                {compareEnabled && draft.comparisonYears.length === 0 ? <p className="mt-2 text-sm font-semibold text-amber-800">Hãy chọn ít nhất một năm so sánh.</p> : null}
              </div> : null}
            </fieldset> : draft.reportType === 'BAO_CAO_SAN_LUONG' ? <p className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-pretty text-sm text-blue-950">Báo cáo theo mẫu BaoCaoSanLuong không áp dụng so sánh nhiều năm.</p> : <fieldset>
              <legend className="text-sm font-bold text-slate-900">Kỳ đối chiếu</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                <label className="text-sm font-semibold"><input className="report-focus mr-2" type="checkbox" checked={draft.comparisons.includes('previous')} onChange={() => toggleComparison('previous')} />Kỳ trước</label>
                <label className="text-sm font-semibold"><input className="report-focus mr-2" type="checkbox" checked={draft.comparisons.includes('year_ago')} onChange={() => toggleComparison('year_ago')} />Cùng kỳ năm trước</label>
              </div>
              {output === 'html' && draft.reportType === 'MONTHLY_OVERVIEW_L2' && draft.comparisons.includes('previous') && draft.comparisons.includes('year_ago') ? <p className="mt-2 text-pretty text-sm text-slate-600">Tự động thêm tháng trước của năm trước để đối chiếu bốn mốc tháng và mức biến động tháng của hai năm.</p> : null}
            </fieldset>}

            <label className="block text-sm font-bold text-slate-900">Múi giờ
              <select className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base" value={draft.timeBasis} onChange={(event) => setDraft((current) => ({ ...current, timeBasis: event.target.value as 'local' | 'utc' }))}>
                <option value="local">Giờ địa phương</option>
                <option value="utc">UTC</option>
              </select>
            </label>

            {stageLabel ? <p className={cn('rounded-xl border p-3 text-pretty text-sm font-semibold', stage === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-cyan-200 bg-cyan-50 text-cyan-950')} role="status">{stageLabel}</p> : null}
            {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-pretty text-sm font-semibold text-rose-900" role="alert">{error}</p> : null}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-slate-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            <button className="report-focus min-h-11 rounded-lg px-4 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50" type="button" disabled={exporting} onClick={close}>Đóng</button>
            <button className="report-focus min-h-11 rounded-lg bg-blue-900 px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={exporting || (draft.reportType === 'PERIOD_ANALYSIS' && compareEnabled && draft.comparisonYears.length === 0)}>{exporting ? 'Đang tạo…' : 'Tạo và tải file'}</button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
