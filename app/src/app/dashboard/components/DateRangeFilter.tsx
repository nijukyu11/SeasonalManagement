'use client';

interface MonthOption {
  key: string;
  label: string;
}

interface SeasonOption {
  id: string;
  seasonCode: string;
  name?: string;
}

interface DateRangeFilterProps {
  monthOptions: MonthOption[];
  monthFrom: string;
  monthTo: string;
  seasonOptions: SeasonOption[];
  selectedSeasonIds: string[];
  onRangeChange: (monthFrom: string, monthTo: string) => void;
  onToggleSeason: (seasonId: string) => void;
}

function optionForKey(options: MonthOption[], key: string): MonthOption | undefined {
  return options.find((option) => option.key === key);
}

function yearForQuarter(options: MonthOption[], activeTo: string): string {
  return (activeTo || options.at(-1)?.key || '').slice(0, 4);
}

function clampRange(options: MonthOption[], from: string, to: string): [string, string] {
  const keys = options.map((option) => option.key);
  const first = keys[0] ?? '';
  const last = keys.at(-1) ?? '';
  const nextFrom = keys.includes(from) ? from : first;
  const nextTo = keys.includes(to) ? to : last;
  return nextFrom && nextTo && nextFrom > nextTo ? [nextTo, nextFrom] : [nextFrom, nextTo];
}

export default function DateRangeFilter({
  monthOptions,
  monthFrom,
  monthTo,
  seasonOptions,
  selectedSeasonIds,
  onRangeChange,
  onToggleSeason,
}: DateRangeFilterProps) {
  const [activeFrom, activeTo] = clampRange(monthOptions, monthFrom, monthTo);
  const selectedSeasonSet = new Set(selectedSeasonIds);

  const applyAll = () => {
    onRangeChange(monthOptions[0]?.key ?? '', monthOptions.at(-1)?.key ?? '');
  };

  const applyLastThree = () => {
    const lastThree = monthOptions.slice(-3);
    onRangeChange(lastThree[0]?.key ?? '', lastThree.at(-1)?.key ?? '');
  };

  const applyQuarter = (quarter: 1 | 2 | 3 | 4) => {
    const year = yearForQuarter(monthOptions, activeTo);
    const startMonth = (quarter - 1) * 3 + 1;
    const from = `${year}-${String(startMonth).padStart(2, '0')}`;
    const to = `${year}-${String(startMonth + 2).padStart(2, '0')}`;
    const available = monthOptions.filter((option) => option.key >= from && option.key <= to);
    onRangeChange(available[0]?.key ?? from, available.at(-1)?.key ?? to);
  };

  return (
    <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Khoảng thời gian</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={applyAll} className="rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container">
              Toàn mùa
            </button>
            <button type="button" onClick={applyLastThree} className="rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container">
              3 tháng gần nhất
            </button>
            {[1, 2, 3, 4].map((quarter) => (
              <button key={quarter} type="button" onClick={() => applyQuarter(quarter as 1 | 2 | 3 | 4)} className="rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container">
                Q{quarter}
              </button>
            ))}
          </div>
        </div>

        <label className="min-w-[140px] text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          Từ tháng
          <select value={activeFrom} onChange={(event) => onRangeChange(event.target.value, activeTo)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
            {monthOptions.length === 0 ? <option value="">Không có tháng</option> : monthOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>

        <label className="min-w-[140px] text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          Đến tháng
          <select value={activeTo} onChange={(event) => onRangeChange(activeFrom, event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
            {monthOptions.length === 0 ? <option value="">Không có tháng</option> : monthOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>

        <div className="min-w-[220px] flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Season data</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {seasonOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onToggleSeason(item.id)}
                title={item.seasonCode}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${selectedSeasonSet.has(item.id) ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container'}`}
              >
                {item.seasonCode}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-on-surface-variant">
            {(optionForKey(monthOptions, activeFrom)?.label ?? activeFrom) || '-'} - {(optionForKey(monthOptions, activeTo)?.label ?? activeTo) || '-'}
          </div>
        </div>
      </div>
    </section>
  );
}
