'use client';

import { useMemo, useState } from 'react';
import type { SeasonalDraftRecord } from '@/lib/seasonalPlanningContract';
import { computePlanningKpi, type PlanningKpiSummary } from '@/lib/planningDashboardSource';
import { FeasibleStdPanel } from './FeasibleStdPanel';
import { NewFlightFeasibilityBox } from './NewFlightFeasibilityBox';
import { DEFAULT_FEASIBLE_STD_PARAMS, type FeasibleStdParams } from '@/lib/feasibleStdAnalysis';
import { formatUiError } from '@/lib/uiDisplayText';

export interface PlanningOverviewProps {
  flights: readonly SeasonalDraftRecord[];
  dateFrom: string;
  dateTo: string;
  seasonRange?: { start: string; end: string };
  selectedOpsDate: string;
  onSelectOpsDate: (date: string) => void;
  availableDates: string[];
  loading?: boolean;
  error?: string | null;
  isStale?: boolean;
  // Summary comparison diff info
  diffSummary?: {
    added: number;
    modified: number;
    removed: number;
    total: number;
    baseTag: string;
  } | null;
  onViewChangesTab: () => void;
}

export function PlanningOverview({
  flights,
  dateFrom,
  dateTo,
  seasonRange,
  selectedOpsDate,
  onSelectOpsDate,
  availableDates,
  loading = false,
  error = null,
  isStale = false,
  diffSummary,
  onViewChangesTab,
}: PlanningOverviewProps) {
  // Shared scenario-only Feasible STD parameters between chart/grid and feasibility box
  const [feasibleParams, setFeasibleParams] = useState<FeasibleStdParams>({ ...DEFAULT_FEASIBLE_STD_PARAMS });

  // Incomplete boundary flag forwarded from daily chart analysis
  const [isIncompleteDay, setIsIncompleteDay] = useState(false);

  // Candidate STD datetime selected from chart to pass into the feasibility evaluation box
  const [candidateDateTime, setCandidateDateTime] = useState<string>('');

  // Compute planning KPI from the same loaded planning source
  const kpi: PlanningKpiSummary = useMemo(() => {
    return computePlanningKpi(flights, dateFrom || null, dateTo || null);
  }, [flights, dateFrom, dateTo]);

  // Box is disabled if loading, error, stale, or empty flights
  const isBoxDisabled = loading || !!error || isStale || flights.length === 0;
  const disableReason = loading
    ? 'Dữ liệu đang tải...'
    : error
    ? `Lỗi tải dữ liệu: ${formatUiError(error)}`
    : isStale
    ? 'Dữ liệu đang làm mới...'
    : flights.length === 0
    ? 'Không có chuyến bay trong khoảng ngày được chọn'
    : null;

  return (
    <div className="space-y-4">
      {/* 1. Compact Planning KPI Row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Tổng chặng</span>
            <span className="material-symbols-outlined text-[18px] text-primary">flight</span>
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.totalLegs.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Trong khoảng ngày đã chọn
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Chuyến đến</span>
            <span className="material-symbols-outlined text-[18px] text-emerald-600">flight_land</span>
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.arrLegs.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Chuyến bay hạ cánh
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Chuyến đi</span>
            <span className="material-symbols-outlined text-[18px] text-sky-600">flight_takeoff</span>
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.depLegs.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Dùng cho phân tích giờ khởi hành khả thi
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Hãng hàng không</span>
            <span className="material-symbols-outlined text-[18px] text-indigo-600">corporate_fare</span>
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.uniqueAirlines}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Hãng đang hoạt động
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Đường bay</span>
            <span className="material-symbols-outlined text-[18px] text-amber-600">alt_route</span>
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.uniqueRoutes}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Tuyến kết nối
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Ngày cao điểm</span>
            <span className="material-symbols-outlined text-[18px] text-rose-600">calendar_today</span>
          </div>
          <div className="mt-1.5 text-lg font-bold text-slate-900 dark:text-white">
            {loading || error ? '-' : kpi.peakDay ? kpi.peakDay.date : '-'}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {loading || error || !kpi.peakDay ? '-' : `${kpi.peakDay.count} chuyến`}
          </div>
        </div>
      </section>

      {/* 2. Feasible STD Section: Chart/Grid (Left) + Evaluation Box (Right) */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <FeasibleStdPanel
            allFlights={flights}
            selectedOpsDate={selectedOpsDate}
            onSelectOpsDate={onSelectOpsDate}
            availableDates={availableDates}
            seasonRange={seasonRange}
            onSelectCandidateStd={setCandidateDateTime}
            candidateDateTime={candidateDateTime}
            params={feasibleParams}
            onChangeParams={setFeasibleParams}
            onIncompleteChange={setIsIncompleteDay}
            loading={loading}
            error={error}
            isStale={isStale}
          />
        </div>
        <div className="min-w-0 xl:col-span-1">
          <NewFlightFeasibilityBox
            allFlights={flights}
            selectedDate={selectedOpsDate}
            params={feasibleParams}
            candidateDateTime={candidateDateTime}
            onCandidateDateTimeChange={setCandidateDateTime}
            seasonRange={seasonRange}
            isIncompleteDay={isIncompleteDay}
            disabled={isBoxDisabled}
            disableReason={disableReason}
          />
        </div>
      </section>

      {/* 3. Summary Comparison Diff Bar */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-200">
            Biến động kế hoạch:
          </span>
          {diffSummary ? (
            <div className="flex items-center gap-3">
              <span className="text-slate-500 dark:text-slate-400">
                So với bản <strong className="text-slate-800 dark:text-slate-200">{diffSummary.baseTag}</strong>:
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                +{diffSummary.added} Thêm mới
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                ~{diffSummary.modified} Điều chỉnh
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-2 py-0.5 font-bold text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                -{diffSummary.removed} Xóa
              </span>
              <span className="text-slate-400">
                (Tổng {diffSummary.total} thay đổi)
              </span>
            </div>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
              Chưa có bản đối chiếu hoặc đây là bản công bố đầu tiên.
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onViewChangesTab}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <span className="material-symbols-outlined text-[16px]">difference</span>
          <span>Xem chi tiết thay đổi</span>
        </button>
      </section>
    </div>
  );
}
