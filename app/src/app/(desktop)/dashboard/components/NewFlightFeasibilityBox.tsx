'use client';

import { useState, useCallback, useMemo } from 'react';
import type { SeasonalDraftRecord } from '@/lib/seasonalPlanningContract';
import {
  evaluateArbitraryCandidateStd,
  type FeasibleStdParams,
  type FeasibleStdAssessmentResult,
} from '@/lib/feasibleStdAnalysis';
import { formatUiError } from '@/lib/uiDisplayText';

export interface NewFlightFeasibilityBoxProps {
  allFlights: readonly SeasonalDraftRecord[];
  selectedDate: string;
  params: FeasibleStdParams;
  candidateDateTime: string;
  onCandidateDateTimeChange: (val: string) => void;
  seasonRange?: { start: string; end: string };
  isIncompleteDay?: boolean;
  disabled?: boolean;
  disableReason?: string | null;
}

export function NewFlightFeasibilityBox({
  allFlights,
  selectedDate,
  params,
  candidateDateTime,
  onCandidateDateTimeChange,
  seasonRange,
  isIncompleteDay = false,
  disabled = false,
  disableReason = null,
}: NewFlightFeasibilityBoxProps) {
  const [rawAssessment, setAssessment] = useState<FeasibleStdAssessmentResult | null>(null);
  const [rawEvalError, setEvalError] = useState<string | null>(null);
  const context = useMemo(() => ({ candidateDateTime, selectedDate, params, allFlights, disabled, isIncompleteDay, start: seasonRange?.start, end: seasonRange?.end }), [candidateDateTime, selectedDate, params, allFlights, disabled, isIncompleteDay, seasonRange?.start, seasonRange?.end]);
  const [evaluatedContext, setEvaluatedContext] = useState<object | null>(null);
  const assessment = evaluatedContext === context ? rawAssessment : null;
  const evalError = evaluatedContext === context ? rawEvalError : null;

  const handleEvaluate = useCallback(() => {
    if (disabled) return;
    setEvaluatedContext(context);
    if (!candidateDateTime) {
      setEvalError('Vui lòng chọn hoặc nhập giờ khởi hành cần xét.');
      setAssessment(null);
      return;
    }


    const candidateDate = candidateDateTime.slice(0, 10);

    // Boundary check: candidate outside season range cannot evaluate as green/feasible
    if (seasonRange?.start && seasonRange?.end) {
      if (candidateDate < seasonRange.start || candidateDate > seasonRange.end) {
        setEvalError(
          `Giờ khởi hành (${candidateDate}) nằm ngoài phạm vi mùa kế hoạch (${seasonRange.start} → ${seasonRange.end}). Không thể đánh giá khả thi.`
        );
        setAssessment(null);
        return;
      }
    }

    // Incomplete boundary policy check
    if (isIncompleteDay) {
      setEvalError(
        'Ngày vận hành được chọn thuộc vùng biên hoặc dữ liệu chưa hoàn chỉnh. Không thể xác nhận khả thi.'
      );
      setAssessment(null);
      return;
    }

    try {
      setEvalError(null);
      const res = evaluateArbitraryCandidateStd(allFlights, candidateDateTime, params);
      setAssessment(res);
    } catch (err: unknown) {
      setAssessment(null);
      setEvalError(formatUiError(err));
    }
  }, [allFlights, candidateDateTime, params, seasonRange, isIncompleteDay, disabled, context]);

  const statusColor = assessment?.candidate.status === 'green'
    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700'
    : assessment?.candidate.status === 'amber'
    ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-700'
    : 'bg-rose-50 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-700';

  const statusBadge = assessment?.candidate.status === 'green'
    ? { label: `Khả thi (tải < ${params.threshold})`, bg: 'bg-emerald-600 text-white' }
    : assessment?.candidate.status === 'amber'
    ? { label: `Đạt ngưỡng (tải = ${params.threshold})`, bg: 'bg-amber-600 text-white' }
    : { label: `Quá tải (tải > ${params.threshold})`, bg: 'bg-rose-600 text-white' };

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            Xét khả năng thêm chuyến
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Mô phỏng đánh giá tải (chỉ xem, không ghi dữ liệu)
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          1 chuyến đi = 1 slot
        </span>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label
            htmlFor="candidate-std-input"
            className="block text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300"
          >
            Giờ khởi hành thử nghiệm
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="candidate-std-input"
              type="datetime-local"
              value={candidateDateTime}
              onChange={(e) => {
                onCandidateDateTimeChange(e.target.value);
                setAssessment(null);
                setEvalError(null);
              }}
              disabled={disabled}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900/50"
            />
            <button
              type="button"
              onClick={handleEvaluate}
              disabled={disabled || !candidateDateTime}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Xét
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Có thể chọn mốc bất kỳ từ biểu đồ hoặc nhập trực tiếp phút lẻ (không làm tròn).
          </p>
        </div>

        {disabled && disableReason && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
            {disableReason}
          </div>
        )}

        {evalError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            {evalError}
          </div>
        )}

        {assessment && (
          <div className={`rounded-lg border p-3.5 ${statusColor}`}>
            <div className="flex items-center justify-between">
              <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${statusBadge.bg}`}>
                {statusBadge.label}
              </span>
              <span className="text-xs font-semibold">
                {assessment.candidate.canAddOne ? '✓ Có thể nhận thêm 1 chuyến' : '✕ Không thể nhận thêm'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded bg-white/60 p-2 dark:bg-slate-950/40">
                <span className="text-slate-500 dark:text-slate-400">Tải hiện tại:</span>
                <p className="text-base font-bold text-slate-900 dark:text-white">
                  {assessment.candidate.maxDemand} <span className="text-xs font-normal text-slate-500">/ {params.threshold} slot</span>
                </p>
              </div>
              <div className="rounded bg-white/60 p-2 dark:bg-slate-950/40">
                <span className="text-slate-500 dark:text-slate-400">Dự kiến sau khi thêm (+1):</span>
                <p className="text-base font-bold text-slate-900 dark:text-white">
                  {assessment.candidate.projectedMax} <span className="text-xs font-normal text-slate-500">/ {params.threshold} slot</span>
                </p>
              </div>
              <div className="rounded bg-white/60 p-2 dark:bg-slate-950/40">
                <span className="text-slate-500 dark:text-slate-400">Thời điểm đạt đỉnh:</span>
                <p className="font-semibold text-slate-900 dark:text-white">
                  {assessment.candidate.peakAt ? assessment.candidate.peakAt.replace('T', ' ') : '-'}
                </p>
              </div>
              <div className="rounded bg-white/60 p-2 dark:bg-slate-950/40">
                <span className="text-slate-500 dark:text-slate-400">Số chuyến còn nhận được:</span>
                <p className="font-semibold text-slate-900 dark:text-white">
                  {assessment.candidate.remaining} slot
                </p>
              </div>
            </div>

            <div className="mt-2.5 border-t border-current/10 pt-2 text-xs leading-relaxed">
              <p className="font-medium">{assessment.explanation}</p>
              <p className="mt-1 text-[11px] opacity-75">
                Cửa sổ xử lý [-{params.slotBeforeMinutes}m, -{params.slotAfterMinutes}m): {assessment.candidate.windowStart.replace('T', ' ')} → {assessment.candidate.windowEnd.replace('T', ' ')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
