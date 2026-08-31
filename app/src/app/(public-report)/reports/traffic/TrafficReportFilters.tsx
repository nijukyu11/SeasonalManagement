'use client';

import { useRef, useState, type FormEvent } from 'react';
import { cn } from '@/lib/cn';
import {
  getTrafficReportPresetRange,
  type NormalizedTrafficReportFilter,
  type TrafficDatePreset,
} from '@/lib/trafficReportContract';
import { TrafficReportMultiSelect } from './TrafficReportMultiSelect';

const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatDate(value: string): string {
  return dateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

function FilterIcon() {
  return <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

export function TrafficReportFilters({ filter, minOpsDate, maxOpsDate, latestCompletedOpsDate, filterOptions, activePreset, loading, onApply, onPreset }: {
  filter: NormalizedTrafficReportFilter;
  minOpsDate: string;
  maxOpsDate: string;
  latestCompletedOpsDate: string;
  filterOptions: { airline: string[]; route: string[]; country: string[] };
  activePreset: TrafficDatePreset | null;
  loading: boolean;
  onApply: (filter: NormalizedTrafficReportFilter) => Promise<boolean>;
  onPreset: (preset: TrafficDatePreset) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<NormalizedTrafficReportFilter>(filter);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const activeDimensionCount = filter.airline.length + filter.route.length + filter.country.length;

  const open = () => {
    setDraft({ ...filter, airline: [...filter.airline], route: [...filter.route], country: [...filter.country] });
    setFieldError(null);
    dialogRef.current?.showModal();
  };

  const close = () => {
    setDraft({ ...filter, airline: [...filter.airline], route: [...filter.route], country: [...filter.country] });
    setFieldError(null);
    dialogRef.current?.close();
  };

  const resetDraft = () => {
    const range = getTrafficReportPresetRange('ytd', minOpsDate, latestCompletedOpsDate);
    setDraft({ ...filter, ...range, type: 'all', airline: [], route: [], country: [], comp: 'previous' });
    setFieldError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.from || !draft.to || draft.from > draft.to) {
      setFieldError('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
      return;
    }
    if (draft.from < minOpsDate || draft.to > maxOpsDate) {
      setFieldError(`Chọn ngày trong phạm vi ${formatDate(minOpsDate)}–${formatDate(maxOpsDate)}.`);
      return;
    }
    setSubmitting(true);
    setFieldError(null);
    const applied = await onApply({ ...draft, type: 'all' });
    setSubmitting(false);
    if (applied) dialogRef.current?.close();
  };

  return (
    <div className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-sm">
      <div className="mx-auto flex min-h-[72px] max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-8">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{formatDate(filter.from)}–{formatDate(filter.to)}</p>
          <p className="mt-1 truncate text-xs text-slate-600">
            {activeDimensionCount > 0 ? `${activeDimensionCount} lựa chọn đang áp dụng` : 'Tất cả hãng, chặng bay và quốc gia'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <fieldset className="hidden gap-2 lg:flex">
            <legend className="sr-only">Khoảng ngày nhanh</legend>
            {([['7d', '7 ngày'], ['30d', '30 ngày'], ['ytd', 'Đầu năm đến nay']] as const).map(([preset, label]) => <button
              key={preset}
              className={cn('report-focus min-h-11 rounded-lg border px-3 text-sm font-bold', activePreset === preset ? 'border-blue-800 bg-blue-50 text-blue-900' : 'border-slate-300 bg-white text-slate-700 hover:border-blue-700')}
              type="button"
              aria-pressed={activePreset === preset}
              disabled={loading}
              onClick={() => onPreset(preset)}
            >{label}</button>)}
          </fieldset>
          <button className="report-focus inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-900 px-4 text-sm font-bold text-white hover:bg-blue-950" type="button" onClick={open}>
            <FilterIcon />
            <span>Bộ lọc</span>
            {activeDimensionCount > 0 ? <span className="inline-flex size-6 items-center justify-center rounded-full bg-white text-xs text-blue-900" aria-label={`${activeDimensionCount} lựa chọn đang áp dụng`}>{activeDimensionCount}</span> : null}
          </button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="report-filter-dialog m-0 max-h-[80dvh] w-full max-w-none overflow-hidden rounded-t-2xl bg-white p-0 text-slate-900 shadow-xl md:m-auto md:max-h-[86dvh] md:max-w-3xl md:rounded-2xl"
        aria-labelledby="traffic-filter-title"
        onCancel={(event) => { event.preventDefault(); close(); }}
      >
        <form className="flex max-h-[80dvh] flex-col md:max-h-[86dvh]" onSubmit={submit}>
          <header className="flex min-h-16 items-center justify-between border-b border-slate-200 px-4 sm:px-6">
            <div>
              <h2 id="traffic-filter-title" className="text-balance text-lg font-bold">Bộ lọc báo cáo</h2>
              <p className="text-xs text-slate-600">Chỉnh phạm vi rồi nhấn Áp dụng.</p>
            </div>
            <button className="report-focus flex size-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100" type="button" aria-label="Đóng bộ lọc" onClick={close}><CloseIcon /></button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
            <fieldset>
              <legend className="text-sm font-bold text-slate-900">Khoảng ngày nhanh</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {([['7d', '7 ngày'], ['30d', '30 ngày'], ['ytd', 'Đầu năm đến nay']] as const).map(([preset, label]) => <button
                  key={preset}
                  className="report-focus min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-blue-900 hover:border-blue-700"
                  type="button"
                  onClick={() => {
                    const range = getTrafficReportPresetRange(preset, minOpsDate, latestCompletedOpsDate);
                    setDraft((current) => ({ ...current, ...range }));
                  }}
                >{label}</button>)}
              </div>
            </fieldset>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-slate-700">Từ ngày
                <input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="date" value={draft.from} min={minOpsDate} max={maxOpsDate} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} required />
              </label>
              <label className="text-sm font-semibold text-slate-700">Đến ngày
                <input className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base" type="date" value={draft.to} min={minOpsDate} max={maxOpsDate} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} required />
              </label>
            </div>
            {fieldError ? <p className="mt-2 text-sm font-semibold text-rose-800" role="alert">{fieldError}</p> : null}
            <p className="mt-2 text-xs leading-5 text-slate-600">Dữ liệu có thể chọn: {formatDate(minOpsDate)}–{formatDate(maxOpsDate)}.</p>

            <div className="mt-6 grid gap-5 md:grid-cols-2">
              <TrafficReportMultiSelect name="airline" label="Hãng hàng không" options={filterOptions.airline} values={draft.airline} placeholder="Tất cả hãng" onChange={(airline) => setDraft((current) => ({ ...current, airline }))} />
              <TrafficReportMultiSelect name="route" label="Chặng bay" options={filterOptions.route} values={draft.route} placeholder="Tất cả chặng bay" onChange={(route) => setDraft((current) => ({ ...current, route }))} />
              <TrafficReportMultiSelect name="country" label="Quốc gia" options={filterOptions.country} values={draft.country} placeholder="Tất cả quốc gia" onChange={(country) => setDraft((current) => ({ ...current, country }))} />
              <label className="text-sm font-semibold text-slate-700">So sánh
                <select className="report-focus mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base" value={draft.comp} onChange={(event) => setDraft((current) => ({ ...current, comp: event.target.value as NormalizedTrafficReportFilter['comp'] }))}>
                  <option value="previous">Kỳ trước liền kề</option>
                  <option value="year_ago">Cùng kỳ năm trước</option>
                  <option value="none">Không so sánh</option>
                </select>
              </label>
            </div>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            <button className="report-focus min-h-11 rounded-lg px-3 text-sm font-bold text-slate-700 hover:bg-slate-100" type="button" onClick={resetDraft}>Đặt lại</button>
            <button className="report-focus min-h-11 rounded-lg bg-blue-900 px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={submitting}>{submitting ? 'Đang áp dụng…' : 'Áp dụng'}</button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}
