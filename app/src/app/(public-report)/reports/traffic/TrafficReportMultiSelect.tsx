import { useMemo, useState } from 'react';

function CloseIcon() {
  return <svg aria-hidden="true" className="size-3" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

export function TrafficReportMultiSelect({ name, label, options, selected, placeholder }: {
  name: 'airline' | 'route';
  label: string;
  options: string[];
  selected: string[];
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const [values, setValues] = useState(() => [...selected]);
  const normalizedQuery = query.trim().toLocaleUpperCase('vi-VN');
  const availableOptions = useMemo(
    () => [...new Set([...values, ...options])].filter((option) => !normalizedQuery || option.toLocaleUpperCase('vi-VN').includes(normalizedQuery)).slice(0, 80),
    [normalizedQuery, options, values],
  );

  const toggle = (option: string) => {
    setValues((current) => current.includes(option)
      ? current.filter((value) => value !== option)
      : current.length >= 24 ? current : [...current, option].sort((left, right) => left.localeCompare(right, 'en')));
  };

  return (
    <fieldset className="min-w-0 text-xs font-semibold text-slate-600">
      <legend>{label}</legend>
      {values.map((value) => <input key={value} type="hidden" name={name} value={value} />)}
      <details className="relative mt-1">
        <summary className="report-focus flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 marker:hidden">
          <span className="truncate">{values.length === 0 ? placeholder : `${values.length} lựa chọn`}</span>
          <svg aria-hidden="true" className="size-4 shrink-0 text-slate-500" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </summary>
        <div className="absolute z-40 mt-2 w-full min-w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <label className="sr-only" htmlFor={`${name}-search`}>Tìm {label.toLocaleLowerCase('vi-VN')}</label>
          <input id={`${name}-search`} className="report-focus min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm font-normal" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Tìm ${label.toLocaleLowerCase('vi-VN')}…`} />
          <div className="mt-2 max-h-60 overflow-y-auto overscroll-contain">
            {availableOptions.length === 0 ? <p className="p-3 text-sm font-normal text-slate-500">Không tìm thấy lựa chọn phù hợp.</p> : availableOptions.map((option) => {
              const checked = values.includes(option);
              return <label key={option} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm font-normal text-slate-700 hover:bg-slate-50">
                <input className="size-4 rounded border-slate-300 text-[#234093]" type="checkbox" checked={checked} disabled={!checked && values.length >= 24} onChange={() => toggle(option)} />
                <span className="truncate">{option}</span>
              </label>;
            })}
          </div>
          <p className="mt-2 text-xs font-normal leading-5 text-slate-500">Tối đa 24 lựa chọn; danh sách chỉ gồm giá trị đã đủ ngưỡng công bố.</p>
        </div>
      </details>
      {values.length > 0 ? <div className="mt-2 flex flex-wrap gap-2" aria-label={`${label} đang chọn`}>
        {values.map((value) => <span key={value} className="inline-flex min-h-8 items-center gap-1 rounded-full bg-slate-100 pl-3 text-xs font-bold text-slate-700">
          <span>{value}</span>
          <button className="report-focus flex min-h-8 min-w-8 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200" type="button" aria-label={`Bỏ ${value} khỏi ${label}`} onClick={() => toggle(value)}><CloseIcon /></button>
        </span>)}
      </div> : null}
      <span className="sr-only" aria-live="polite">Đã chọn {values.length} {label.toLocaleLowerCase('vi-VN')}.</span>
    </fieldset>
  );
}
