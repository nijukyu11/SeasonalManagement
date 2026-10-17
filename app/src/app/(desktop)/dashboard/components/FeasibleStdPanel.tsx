'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Cell,
  CartesianGrid,
} from 'recharts';
import type { SeasonalDraftRecord } from '@/lib/seasonalPlanningContract';
import {
  analyzeDayFeasibleStd,
  DEFAULT_FEASIBLE_STD_PARAMS,
  type FeasibleStdParams,
  type FeasibleStdCandidatePoint,
  type DayFeasibleStdResult,
} from '@/lib/feasibleStdAnalysis';
import { formatUiError } from '@/lib/uiDisplayText';

export interface FeasibleStdPanelProps {
  allFlights: readonly SeasonalDraftRecord[];
  selectedOpsDate: string;
  onSelectOpsDate: (date: string) => void;
  availableDates: string[];
  seasonRange?: { start: string; end: string };
  onSelectCandidateStd: (stdIso: string) => void;
  candidateDateTime: string;
  params: FeasibleStdParams;
  onChangeParams: (params: FeasibleStdParams) => void;
  onIncompleteChange?: (isIncomplete: boolean) => void;
  loading?: boolean;
  error?: string | null;
  isStale?: boolean;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: FeasibleStdCandidatePoint }>;
  threshold: number;
}

function FeasibleStdTooltip({ active, payload, threshold }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0].payload;

  return (
    <div className="z-50 rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-1.5 font-bold text-slate-900 dark:border-slate-800 dark:text-white">
        <span>Giờ khởi hành: {item.candidateStd.replace('T', ' ')}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            item.status === 'green'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : item.status === 'amber'
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              : 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
          }`}
        >
          {item.status === 'green' ? 'Khả thi' : item.status === 'amber' ? 'Đạt ngưỡng' : 'Quá tải'}
        </span>
      </div>
      <div className="mt-2 space-y-1 text-slate-600 dark:text-slate-300">
        <div>
          <span className="font-semibold text-slate-500 dark:text-slate-400">Cửa sổ xử lý:</span>{' '}
          {item.windowStart.slice(11, 16)} → {item.windowEnd.slice(11, 16)}
        </div>
        <div>
          <span className="font-semibold text-slate-500 dark:text-slate-400">Nhu cầu lớn nhất:</span>{' '}
          <span className="font-bold text-slate-900 dark:text-white">{item.maxDemand}</span> / {threshold} slot
        </div>
        <div>
          <span className="font-semibold text-slate-500 dark:text-slate-400">Thời điểm đạt đỉnh:</span>{' '}
          {item.peakAt ? item.peakAt.slice(11, 16) : '-'}
        </div>
        <div>
          <span className="font-semibold text-slate-500 dark:text-slate-400">Còn có thể nhận:</span>{' '}
          {item.remaining} slot
        </div>
        <div className="border-t border-slate-100 pt-1 text-[11px] font-medium text-primary dark:border-slate-800">
          {item.canAddOne ? '✓ Có thể nhận thêm 1 chuyến' : '✕ Không thể nhận thêm 1 chuyến'}
        </div>
        <div className="text-[10px] text-slate-400">
          (Click cột để đưa vào hộp xét khả năng)
        </div>
      </div>
    </div>
  );
}

export function FeasibleStdPanel({
  allFlights,
  selectedOpsDate,
  onSelectOpsDate,
  availableDates,
  seasonRange,
  onSelectCandidateStd,
  candidateDateTime,
  params,
  onChangeParams,
  onIncompleteChange,
  loading = false,
  error = null,
  isStale = false,
}: FeasibleStdPanelProps) {
  const [showParams, setShowParams] = useState(false);
  const [viewMode, setViewMode] = useState<'chart' | 'grid'>('chart');

  // Compute Feasible STD for selected day
  const result: DayFeasibleStdResult = useMemo(() => {
    if (!selectedOpsDate || allFlights.length === 0) {
      return {
        opsDate: selectedOpsDate,
        params,
        candidates: [],
        countedDepFlights: 0,
        overallMaxDemand: 0,
        overallPeakAt: null,
        hasFlights: false,
        isIncomplete: false,
      };
    }
    return analyzeDayFeasibleStd(allFlights, selectedOpsDate, params, seasonRange);
  }, [allFlights, selectedOpsDate, params, seasonRange]);

  useEffect(() => {
    onIncompleteChange?.(result.isIncomplete);
  }, [result.isIncomplete, onIncompleteChange]);

  const handleResetParams = useCallback(() => {
    onChangeParams({ ...DEFAULT_FEASIBLE_STD_PARAMS });
  }, [onChangeParams]);
  const maxChartY = Math.max(params.threshold + 2, result.overallMaxDemand + 1);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ops-date-select" className="text-xs font-bold text-slate-700 dark:text-slate-300">
            Ngày vận hành (05:00 → 05:00):
          </label>
          <select
            id="ops-date-select"
            value={selectedOpsDate}
            onChange={(e) => onSelectOpsDate(e.target.value)}
            disabled={loading || availableDates.length === 0}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          >
            {availableDates.length === 0 ? (
              <option value="">Không có ngày</option>
            ) : (
              availableDates.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))
            )}
          </select>

          <span className="text-xs text-slate-500 dark:text-slate-400">
            ({result.countedDepFlights} chuyến đi)
          </span>

          {isStale && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Đang làm mới...
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setViewMode('chart')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === 'chart'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              Biểu đồ
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === 'grid'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              Bảng mốc giờ
            </button>
          </div>

          {/* Scenario Params Toggle */}
          <button
            type="button"
            onClick={() => setShowParams((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-[16px]">tune</span>
            <span>Tham số kịch bản</span>
          </button>
        </div>
      </div>

      {/* Scenario Parameters Drawer/Card */}
      {showParams && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/60">
          <div className="flex items-center justify-between pb-2 font-bold text-slate-900 dark:text-white">
            <span>Tham số tính giờ khởi hành khả thi (mô phỏng)</span>
            <button
              type="button"
              onClick={handleResetParams}
              className="text-xs font-medium text-primary hover:underline"
            >
              Đặt lại mặc định
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Ngưỡng xử lý (slot)
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={params.threshold}
                onChange={(e) =>
                  onChangeParams({ ...params, threshold: Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 13)) })
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Cửa sổ trước (phút)
              </label>
              <input
                type="number"
                min={Math.max(10, params.slotAfterMinutes + 1)}
                max={300}
                value={params.slotBeforeMinutes}
                onChange={(e) =>
                  onChangeParams({ ...params, slotBeforeMinutes: Math.min(300, Math.max(10, params.slotAfterMinutes + 1, parseInt(e.target.value, 10) || 180)) })
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Cửa sổ sau (phút)
              </label>
              <input
                type="number"
                min={0}
                max={params.slotBeforeMinutes - 1}
                value={params.slotAfterMinutes}
                onChange={(e) =>
                  onChangeParams({ ...params, slotAfterMinutes: Math.min(params.slotBeforeMinutes - 1, Math.max(0, Number.isFinite(e.target.valueAsNumber) ? Math.trunc(e.target.valueAsNumber) : 50)) })
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Bước lưới (phút)
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={params.stepMinutes}
                onChange={(e) =>
                  onChangeParams({ ...params, stepMinutes: Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 5)) })
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Giờ chốt ngày vận hành (cố định)
              </label>
              <input
                type="text"
                disabled
                className="mt-1 w-full cursor-not-allowed rounded border border-slate-200 bg-slate-100 px-2 py-1 text-slate-500 dark:border-slate-700 dark:bg-slate-900/50"
              />
            </div>
          </div>
        </div>
      )}

      {/* Main Body */}
      <div className="mt-4">
        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-slate-500">
            <span className="material-symbols-outlined mr-2 animate-spin text-[20px]">sync</span>
            Đang tính khả năng tiếp nhận giờ khởi hành...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            {formatUiError(error)}
          </div>
        ) : !result.hasFlights ? (
          <div className="flex h-64 flex-col items-center justify-center text-slate-400">
            <span className="material-symbols-outlined text-[36px]">event_busy</span>
            <p className="mt-2 text-sm font-medium">Không có chuyến bay khởi hành trong ngày {selectedOpsDate}</p>
            <p className="text-xs text-slate-400">
              Vẫn có thể dùng hộp bên cạnh để đánh giá một chuyến bay đầu tiên.
            </p>
          </div>
        ) : viewMode === 'chart' ? (
          <div>
            {/* Legend & Stats */}
            <div className="mb-2 flex flex-wrap items-center justify-between text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-emerald-600" />
                  <span>Khả thi (&lt; {params.threshold})</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-amber-500" />
                  <span>Đạt ngưỡng (= {params.threshold})</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-rose-600" />
                  <span>Quá tải (&gt; {params.threshold})</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0 w-4 border-t-2 border-dashed border-rose-500" />
                  <span>Ngưỡng tối đa ({params.threshold})</span>
                </span>
              </div>
              <div>
                Đỉnh tải ngày: <strong className="text-slate-900 dark:text-white">{result.overallMaxDemand} slot</strong>
                {result.overallPeakAt && (
                  <span> lúc {result.overallPeakAt.replace('T', ' ')}</span>
                )}
              </div>
            </div>

            {/* Recharts Bar Chart */}
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={result.candidates}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                  <XAxis
                    dataKey="stdLabel"
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={25}
                  />
                  <YAxis
                    domain={[0, maxChartY]}
                    allowDecimals={false}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip
                    content={<FeasibleStdTooltip threshold={params.threshold} />}
                  />
                  <ReferenceLine
                    y={params.threshold}
                    stroke="#dc2626"
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                  />
                  <Bar
                    dataKey="maxDemand"
                    radius={[2, 2, 0, 0]}
                    cursor="pointer"
                    onClick={(entry) => onSelectCandidateStd(entry.payload.candidateStd)}
                  >
                    {result.candidates.map((entry) => {
                      const color =
                        entry.status === 'green'
                          ? '#16a34a'
                          : entry.status === 'amber'
                          ? '#d97706'
                          : '#dc2626';
                      const isSelected = candidateDateTime && entry.candidateStd.startsWith(candidateDateTime);
                      return (
                        <Cell
                          key={entry.candidateStd}
                          fill={color}
                          stroke={isSelected ? '#0284c7' : 'none'}
                          strokeWidth={isSelected ? 2 : 0}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-center text-[11px] text-slate-400">
              Nhấp chuột vào một cột mốc giờ trên biểu đồ để đưa thời gian vào khung &quot;Xét khả năng thêm chuyến&quot;.
            </p>
          </div>
        ) : (
          /* Table Grid View */
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                <tr>
                  <th className="px-3 py-2">Mốc giờ khởi hành</th>
                  <th className="px-3 py-2">Cửa sổ xử lý ({params.slotBeforeMinutes - params.slotAfterMinutes}m)</th>
                  <th className="px-3 py-2">Đạt đỉnh lúc</th>
                  <th className="px-3 py-2">Trạng thái</th>
                  <th className="px-3 py-2">Còn lại</th>
                  <th className="px-3 py-2">Dự kiến (+1)</th>
                  <th className="px-3 py-2 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {result.candidates.map((row) => (
                  <tr
                    key={row.candidateStd}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                      candidateDateTime && row.candidateStd.startsWith(candidateDateTime)
                        ? 'bg-sky-50 dark:bg-sky-950/30'
                        : ''
                    }`}
                  >
                    <td className="px-3 py-1.5 font-bold text-slate-900 dark:text-white">
                      {row.stdLabel}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">
                      {row.windowStart.slice(11, 16)} → {row.windowEnd.slice(11, 16)}
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-slate-900 dark:text-white">
                      {row.maxDemand} / {params.threshold}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">
                      {row.peakAt ? row.peakAt.slice(11, 16) : '-'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          row.status === 'green'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            : row.status === 'amber'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            : 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                        }`}
                      >
                        {row.status === 'green' ? 'Khả thi' : row.status === 'amber' ? 'Đạt ngưỡng' : 'Quá tải'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                      {row.remaining} slot
                    </td>
                    <td className="px-3 py-1.5">
                      {row.canAddOne ? (
                        <span className="font-semibold text-emerald-600">✓ {row.projectedMax} slot</span>
                      ) : (
                        <span className="font-semibold text-rose-600">✕ {row.projectedMax} slot</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => onSelectCandidateStd(row.candidateStd)}
                        className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      >
                        Chọn
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
