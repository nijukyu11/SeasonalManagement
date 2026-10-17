'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import type { SeasonalDraftRecord } from '@/lib/seasonalPlanningContract';
import {
  buildSlotOccupancyDataset,
  filterSlotDayIndices,
  computeSlotSelectionStats,
  computeSlotKpiCards,
  buildSlotFlightGroups,
  buildSlotStdTable30Min,
  buildSlotMonthWeekdayMatrix,
  formatSlotMinuteLabel,
  formatSlotMonthLabel,
  resolveSlotStatusColor,
  DEFAULT_SLOT_OCCUPANCY_PARAMS,
  WEEKDAY_LABELS_VN,
  type SlotOccupancyParams,
  type SlotStatusColor,
} from '@/lib/slotOccupancyAnalysis';
import { formatUiError } from '@/lib/uiDisplayText';

export interface SlotOccupancyReportPanelProps {
  flights: readonly SeasonalDraftRecord[];
  seasonCode?: string;
  dateFrom?: string;
  dateTo?: string;
  loading?: boolean;
  error?: string | null;
  isStale?: boolean;
}

const COLOR_HEX: Readonly<Record<SlotStatusColor, string>> = {
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
};

const FILL_RGBA: Readonly<Record<SlotStatusColor, string>> = {
  green: 'rgba(34,197,94,0.55)',
  amber: 'rgba(245,158,11,0.65)',
  red: 'rgba(239,68,68,0.55)',
};

const AREA_RGBA: Readonly<Record<SlotStatusColor, string>> = {
  green: 'rgba(34,197,94,0.18)',
  amber: 'rgba(245,158,11,0.18)',
  red: 'rgba(239,68,68,0.18)',
};

const GANTT_BAR_RGBA: Readonly<Record<SlotStatusColor, string>> = {
  green: 'rgba(96,165,250,0.8)',
  amber: 'rgba(245,158,11,0.8)',
  red: 'rgba(248,113,113,0.85)',
};

const STATUS_LABEL_VN: Readonly<Record<SlotStatusColor, string>> = {
  green: '🟢 Nhận được',
  amber: '🟡 Hạn chế',
  red: '🔴 Không nhận',
};

interface HoverTooltipState {
  x: number;
  y: number;
  title: string;
  statusColor?: SlotStatusColor;
  lines: string[];
  mutedLine?: string;
}

function setupHiDpiCanvas(
  canvas: HTMLCanvasElement,
  heightCss: number
): [CanvasRenderingContext2D | null, number] {
  const parentWidth = canvas.parentElement?.clientWidth ?? 800;
  const widthCss = Math.max(320, parentWidth);
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.round(widthCss * ratio);
  canvas.height = Math.round(heightCss * ratio);
  canvas.style.width = `${widthCss}px`;
  canvas.style.height = `${heightCss}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  return [ctx, widthCss];
}

function drawChartAxesAndGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pl: number,
  pt: number,
  pb: number,
  maxY: number,
  numCandidates: number,
  opsStart: number,
  step: number
): void {
  const ys = (v: number) => pt + (height - pt - pb) * (1 - v / maxY);
  ctx.font = '10px "Segoe UI", sans-serif';
  const yStep = maxY > 28 ? 4 : 2;
  for (let v = 0; v <= maxY; v += yStep) {
    const y = ys(v);
    ctx.strokeStyle = '#eef0f3';
    ctx.beginPath();
    ctx.moveTo(pl, y);
    ctx.lineTo(width - 10, y);
    ctx.stroke();
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'right';
    ctx.fillText(String(v), pl - 5, y + 3);
  }

  const bw = (width - pl - 10) / numCandidates;
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'center';
  const tickInterval = Math.max(1, Math.round(60 / step));
  for (let i = 0; i < numCandidates; i += tickInterval) {
    ctx.fillText(
      formatSlotMinuteLabel(opsStart + i * step),
      pl + i * bw + bw / 2,
      height - pb + 16
    );
  }
}

function drawThresholdReferenceLine(
  ctx: CanvasRenderingContext2D,
  pl: number,
  width: number,
  yThreshold: number,
  threshold: number
): void {
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pl, yThreshold);
  ctx.lineTo(width - 10, yThreshold);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.fillStyle = '#ef4444';
  ctx.font = 'bold 10px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`= ${threshold}`, width - 12, yThreshold - 4);
}

export function SlotOccupancyReportPanel({
  flights,
  seasonCode = 'W26',
  dateFrom,
  dateTo,
  loading = false,
  error = null,
  isStale = false,
}: SlotOccupancyReportPanelProps) {
  const [params, setParams] = useState<SlotOccupancyParams>({
    ...DEFAULT_SLOT_OCCUPANCY_PARAMS,
  });
  const [showParamsDrawer, setShowParamsDrawer] = useState(false);
  const [selMo, setSelMo] = useState<number | null>(null);
  const [selWd, setSelWd] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<HoverTooltipState | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  const panelTopRef = useRef<HTMLDivElement>(null);
  const feasCanvasRef = useRef<HTMLCanvasElement>(null);
  const clockCanvasRef = useRef<HTMLCanvasElement>(null);
  const ganttCanvasRef = useRef<HTMLCanvasElement>(null);

  const dataset = useMemo(() => {
    return buildSlotOccupancyDataset(flights, params, { dateFrom, dateTo });
  }, [flights, params, dateFrom, dateTo]);

  // Reset selected month if it is no longer present in dataset
  const effectiveSelMo = useMemo(() => {
    if (selMo !== null && !dataset.months.includes(selMo)) {
      return null;
    }
    return selMo;
  }, [selMo, dataset.months]);

  const selectedIndices = useMemo(() => {
    return filterSlotDayIndices(dataset, effectiveSelMo, selWd);
  }, [dataset, effectiveSelMo, selWd]);

  const stats = useMemo(() => {
    return computeSlotSelectionStats(dataset, selectedIndices);
  }, [dataset, selectedIndices]);

  const kpiCards = useMemo(() => {
    return computeSlotKpiCards(dataset, selectedIndices, stats);
  }, [dataset, selectedIndices, stats]);

  const ganttGroups = useMemo(() => {
    return buildSlotFlightGroups(dataset, selectedIndices, false);
  }, [dataset, selectedIndices]);

  const table30Rows = useMemo(() => {
    return buildSlotStdTable30Min(dataset, selectedIndices, stats);
  }, [dataset, selectedIndices, stats]);

  const matrixMap = useMemo(() => {
    return buildSlotMonthWeekdayMatrix(dataset);
  }, [dataset]);

  // Resize observer to re-render canvases cleanly when container width changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setViewportTick((t) => t + 1);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Draw Chart 1 (Feasible STD bar chart - #c2 in template.html)
  useEffect(() => {
    const canvas = feasCanvasRef.current;
    if (!canvas || selectedIndices.length === 0) return;
    const H = 250;
    const [ctx, W] = setupHiDpiCanvas(canvas, H);
    if (!ctx) return;

    const P = dataset.params;
    const NC = dataset.numCandidates;
    const pl = 34;
    const pt = 12;
    const pb = 40;
    const maxAvgRounded = stats.avg.reduce((acc, v) => Math.max(acc, Math.round(v)), 0);
    const mx = Math.max(P.threshold + 3, maxAvgRounded);
    const ys = (v: number) => pt + (H - pt - pb) * (1 - v / mx);
    const bw = (W - pl - 10) / NC;

    ctx.clearRect(0, 0, W, H);
    drawChartAxesAndGrid(ctx, W, H, pl, pt, pb, mx, NC, P.opsStart, P.step);

    // Subtle green background below threshold
    ctx.fillStyle = 'rgba(34,197,94,0.07)';
    ctx.fillRect(pl, ys(P.threshold), W - pl - 10, ys(0) - ys(P.threshold));

    stats.avg.forEach((v, k) => {
      const roundedV = Math.round(v);
      const sc = resolveSlotStatusColor(stats.pctC[k], P);
      ctx.fillStyle = FILL_RGBA[sc];
      ctx.fillRect(
        pl + k * bw,
        ys(roundedV),
        Math.max(1, bw - 0.6),
        ys(0) - ys(roundedV)
      );
    });

    drawThresholdReferenceLine(ctx, pl, W, ys(P.threshold), P.threshold);
  }, [dataset, stats, selectedIndices.length, viewportTick]);

  // Draw Chart 2 (Clock-time demand chart - #c1 in template.html)
  useEffect(() => {
    const canvas = clockCanvasRef.current;
    if (!canvas || selectedIndices.length === 0) return;
    const H = 250;
    const [ctx, W] = setupHiDpiCanvas(canvas, H);
    if (!ctx) return;

    const P = dataset.params;
    const NC = dataset.numCandidates;
    const pl = 34;
    const pt = 12;
    const pb = 40;
    const maxDmax = stats.dmax.reduce((acc, v) => Math.max(acc, v), 0);
    const mx = Math.max(P.threshold + 3, maxDmax);
    const ys = (v: number) => pt + (H - pt - pb) * (1 - v / mx);
    const bw = (W - pl - 10) / NC;
    const xs = (k: number) => pl + k * bw + bw / 2;

    ctx.clearRect(0, 0, W, H);
    drawChartAxesAndGrid(ctx, W, H, pl, pt, pb, mx, NC, P.opsStart, P.step);

    // Gray min-max band
    ctx.fillStyle = 'rgba(156,163,175,0.22)';
    ctx.beginPath();
    stats.dmax.forEach((v, k) => {
      if (k === 0) ctx.moveTo(xs(k), ys(v));
      else ctx.lineTo(xs(k), ys(v));
    });
    for (let k = NC - 1; k >= 0; k--) {
      ctx.lineTo(xs(k), ys(stats.dmin[k]));
    }
    ctx.closePath();
    ctx.fill();

    // Colored segments & line for rounded davg
    for (let k = 0; k < NC - 1; k++) {
      const sc = resolveSlotStatusColor(Math.min(stats.dok[k], stats.dok[k + 1]), P);
      ctx.fillStyle = AREA_RGBA[sc];
      ctx.beginPath();
      ctx.moveTo(xs(k), ys(0));
      ctx.lineTo(xs(k), ys(Math.round(stats.davg[k])));
      ctx.lineTo(xs(k + 1), ys(Math.round(stats.davg[k + 1])));
      ctx.lineTo(xs(k + 1), ys(0));
      ctx.fill();

      ctx.strokeStyle = COLOR_HEX[sc];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xs(k), ys(Math.round(stats.davg[k])));
      ctx.lineTo(xs(k + 1), ys(Math.round(stats.davg[k + 1])));
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    drawThresholdReferenceLine(ctx, pl, W, ys(P.threshold), P.threshold);
  }, [dataset, stats, selectedIndices.length, viewportTick]);

  // Draw Chart 3 (Aggregated Gantt timeline - #c3 in template.html)
  useEffect(() => {
    const canvas = ganttCanvasRef.current;
    if (!canvas || selectedIndices.length === 0) return;

    const P = dataset.params;
    const bh = 13;
    const gap = 3;
    const pl = 175;
    const pt = 24;
    const H = Math.max(80, pt + ganttGroups.length * (bh + gap) + 8);
    const [ctx, W] = setupHiDpiCanvas(canvas, H);
    if (!ctx) return;

    const t0 = -P.slotBefore - 10;
    const t1 = 1450;
    const xs = (t: number) => pl + ((t - t0) / (t1 - t0)) * (W - pl - 10);

    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px "Segoe UI", sans-serif';

    for (let h = -3; h <= 24; h++) {
      ctx.strokeStyle = h === 0 || h === 24 ? '#9ca3af' : '#eef0f3';
      ctx.beginPath();
      ctx.moveTo(xs(h * 60), pt - 4);
      ctx.lineTo(xs(h * 60), H);
      ctx.stroke();
      if (h % 2 === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText(formatSlotMinuteLabel(P.opsStart + h * 60), xs(h * 60), pt - 10);
      }
    }

    ganttGroups.forEach((f, i) => {
      const y = pt + i * (bh + gap);
      const a = xs(f.std - P.slotBefore);
      const b = xs(f.std - P.slotAfter);

      let worst: SlotStatusColor = 'green';
      for (let t = f.std - P.slotBefore; t < f.std - P.slotAfter; t += P.step) {
        const k = Math.floor(t / P.step);
        if (k < 0 || k >= stats.dok.length) continue;
        const sc = resolveSlotStatusColor(stats.dok[k], P);
        if (sc === 'red') {
          worst = 'red';
          break;
        }
        if (sc === 'amber') worst = 'amber';
      }

      ctx.globalAlpha = 0.35 + (0.65 * f.n) / selectedIndices.length;
      ctx.fillStyle = GANTT_BAR_RGBA[worst];
      ctx.fillRect(a, y, Math.max(1, b - a), bh);
      ctx.globalAlpha = 1;

      if (f.slots === 2) {
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 2;
        ctx.strokeRect(a, y, Math.max(1, b - a), bh);
        ctx.lineWidth = 1;
      }

      // STD triangle marker ▼
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(xs(f.std), y + bh);
      ctx.lineTo(xs(f.std) - 4, y + 2);
      ctx.lineTo(xs(f.std) + 4, y + 2);
      ctx.fill();

      ctx.fillStyle = '#374151';
      ctx.textAlign = 'right';
      ctx.fillText(
        `${f.name} ${formatSlotMinuteLabel(P.opsStart + f.std)}${f.slots === 2 ? ' ×2' : ''} · ${f.n}/${selectedIndices.length}`,
        pl - 6,
        y + bh - 2
      );
    });
  }, [dataset, stats, ganttGroups, selectedIndices.length, viewportTick]);

  const handleFeasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = feasCanvasRef.current;
    if (!canvas || selectedIndices.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const pl = 34;
    const bw = (rect.width - pl - 10) / dataset.numCandidates;
    const k = Math.floor((e.clientX - rect.left - pl) / bw);
    if (k < 0 || k >= dataset.numCandidates) {
      setTooltip(null);
      return;
    }
    const P = dataset.params;
    const t = P.opsStart + k * P.step;
    const sc = resolveSlotStatusColor(stats.pctC[k], P);
    setTooltip({
      x: e.clientX,
      y: e.clientY,
      title: `Chuyến STD ${formatSlotMinuteLabel(t)}`,
      statusColor: sc,
      lines: [
        `Code C: ${stats.pctC[k] >= P.okGreen ? '✅ Nhận' : '❌ Không nhận'} (${Math.round(stats.pctC[k])}% số ngày)`,
        `Code D/E: ${stats.pctDE[k] >= P.okGreen ? '✅ Nhận' : '❌ Không nhận'} (${Math.round(stats.pctDE[k])}% số ngày)`,
        `Slot còn trống TB: ${Math.max(0, P.threshold - Math.round(stats.avg[k]))} · nhu cầu đỉnh TB ${Math.round(stats.avg[k])}, cao nhất ${stats.max[k]}`,
      ],
      mutedLine: `Chiếm slot (tham khảo): ${formatSlotMinuteLabel(t - P.slotBefore)} → ${formatSlotMinuteLabel(t - P.slotAfter)}`,
    });
  };

  const handleClockMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = clockCanvasRef.current;
    if (!canvas || selectedIndices.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const pl = 34;
    const bw = (rect.width - pl - 10) / dataset.numCandidates;
    const k = Math.floor((e.clientX - rect.left - pl) / bw);
    if (k < 0 || k >= dataset.numCandidates) {
      setTooltip(null);
      return;
    }
    const P = dataset.params;
    const sc = resolveSlotStatusColor(stats.dok[k], P);
    setTooltip({
      x: e.clientX,
      y: e.clientY,
      title: formatSlotMinuteLabel(P.opsStart + k * P.step),
      statusColor: sc,
      lines: [
        `Nhu cầu TB: ${Math.round(stats.davg[k])} (thấp nhất ${stats.dmin[k]}, cao nhất ${stats.dmax[k]})`,
        `% ngày còn < ${P.threshold} slot: ${Math.round(stats.dok[k])}%`,
      ],
    });
  };

  const handleGanttMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ganttCanvasRef.current;
    if (!canvas || ganttGroups.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const pt = 24;
    const bh = 13;
    const gap = 3;
    const i = Math.floor((e.clientY - rect.top - pt) / (bh + gap));
    if (i < 0 || i >= ganttGroups.length) {
      setTooltip(null);
      return;
    }
    const P = dataset.params;
    const f = ganttGroups[i];
    setTooltip({
      x: e.clientX,
      y: e.clientY,
      title: `${f.name}${f.route ? ` → ${f.route}` : ''}`,
      lines: [
        `STD ${formatSlotMinuteLabel(P.opsStart + f.std)} · ${f.type || 'N/A'} · ${f.slots} slot`,
        `Slot: ${formatSlotMinuteLabel(P.opsStart + f.std - P.slotBefore)} → ${formatSlotMinuteLabel(P.opsStart + f.std - P.slotAfter)}`,
        `Khai thác ${f.n}/${selectedIndices.length} ngày`,
      ],
    });
  };

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <span className="material-symbols-outlined mr-2 animate-spin text-[20px]">sync</span>
        Đang tính toán báo cáo Slot khởi hành ({seasonCode})...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
        {formatUiError(error)}
      </div>
    );
  }

  if (dataset.days.length === 0) {
    return (
      <div className="flex h-80 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <span className="material-symbols-outlined text-[40px]">event_busy</span>
        <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Không có chuyến bay khởi hành (DEP) trong khoảng ngày được chọn
        </p>
      </div>
    );
  }

  const P = dataset.params;
  const firstSelectedDay = selectedIndices.length > 0 ? dataset.days[selectedIndices[0]] : '-';
  const lastSelectedDay =
    selectedIndices.length > 0 ? dataset.days[selectedIndices[selectedIndices.length - 1]] : '-';

  return (
    <div ref={panelTopRef} className="space-y-3.5 text-slate-800 dark:text-slate-100">
      {/* Banner Header matching template.html */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              ✈️ Flight Slot Occupancy Dashboard — {seasonCode}
            </h2>
            {isStale && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Đang làm mới...
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Ngày vận hành {dataset.days[0]} → {dataset.days[dataset.days.length - 1]} ({dataset.days.length} ngày)
            {' · '}Khung giờ chiếm slot STD−{P.slotBefore} → STD−{P.slotAfter}
            {' · '}Ngưỡng ≤ {P.threshold}
            {' · '}
            {P.slotWeightMode === 'aircraft_code'
              ? 'Tàu code D/E = 2 slot'
              : 'Mọi chuyến DEP = 1 slot'}
            {' · '}Ngày VH 05:00 → 05:00
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowParamsDrawer((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-[16px]">tune</span>
            <span>Thông số tính slot</span>
          </button>

          <button
            type="button"
            disabled
            title="Tính năng xuất file Excel báo cáo Slot đang ở trạng thái TBD và sẽ được bổ sung trong phiên chỉnh sửa sau"
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-400 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-500"
          >
            <span className="material-symbols-outlined text-[16px]">table_view</span>
            <span>Xuất Excel báo cáo (TBD)</span>
          </button>
        </div>
      </div>

      {/* Collapsible Parameters Drawer */}
      {showParamsDrawer && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
          <div className="flex items-center justify-between border-b border-slate-200 pb-2.5 font-bold text-slate-900 dark:border-slate-800 dark:text-white">
            <span>Thông số tính slot (mặc định chuẩn W26)</span>
            <button
              type="button"
              onClick={() => setParams({ ...DEFAULT_SLOT_OCCUPANCY_PARAMS })}
              className="text-xs font-semibold text-primary hover:underline"
            >
              Khôi phục mặc định
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Chiếm slot từ STD − (phút)
              </label>
              <input
                type="number"
                min={10}
                max={360}
                value={params.slotBefore}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    slotBefore: Math.min(360, Math.max(p.slotAfter + 5, parseInt(e.target.value, 10) || 180)),
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                đến STD − (phút)
              </label>
              <input
                type="number"
                min={0}
                max={params.slotBefore - 5}
                value={params.slotAfter}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    slotAfter: Math.min(
                      p.slotBefore - 5,
                      Math.max(0, Number.isFinite(e.target.valueAsNumber) ? Math.trunc(e.target.valueAsNumber) : 50)
                    ),
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Ngưỡng tối đa (slot)
              </label>
              <input
                type="number"
                min={2}
                max={50}
                value={params.threshold}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    threshold: Math.min(50, Math.max(2, parseInt(e.target.value, 10) || 13)),
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Ngưỡng Xanh lá ≥ (% ngày)
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={params.okGreen}
                onChange={(e) =>
                  setParams((p) => {
                    const nextGreen = Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 85));
                    return {
                      ...p,
                      okGreen: nextGreen,
                      okAmber: Math.min(p.okAmber, nextGreen),
                    };
                  })
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Ngưỡng Vàng ≥ (% ngày)
              </label>
              <input
                type="number"
                min={1}
                max={params.okGreen}
                value={params.okAmber}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    okAmber: Math.min(p.okGreen, Math.max(1, parseInt(e.target.value, 10) || 50)),
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Quy tắc trọng số tàu bay
              </label>
              <select
                value={params.slotWeightMode}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    slotWeightMode: e.target.value === 'uniform' ? 'uniform' : 'aircraft_code',
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="aircraft_code">Code C = 1, Code D/E = 2 slot</option>
                <option value="uniform">Đồng nhất 1 chuyến = 1 slot</option>
              </select>
            </div>
          </div>

          {dataset.twoSlotAircraftTypes.length > 0 && (
            <div className="mt-2.5 text-[11px] text-slate-500 dark:text-slate-400">
              <strong>Tàu tính 2 slot (Code D/E/F) đang có trong lịch:</strong>{' '}
              {dataset.twoSlotAircraftTypes.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* 1. Scope Selector Card (🔎 Phạm vi xem) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-white">🔎 Phạm vi xem</h3>

        <div className="my-1.5 flex flex-wrap items-center gap-2.5">
          <b className="w-16 text-xs text-slate-700 dark:text-slate-300">Tháng</b>
          <div className="inline-flex flex-wrap gap-1">
            {([null, ...dataset.months] as Array<number | null>).map((mo) => {
              const active = effectiveSelMo === mo;
              return (
                <button
                  key={mo ?? 'all'}
                  type="button"
                  onClick={() => setSelMo(mo)}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                    active
                      ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                  }`}
                >
                  {formatSlotMonthLabel(mo)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="my-1.5 flex flex-wrap items-center gap-2.5">
          <b className="w-16 text-xs text-slate-700 dark:text-slate-300">Thứ</b>
          <div className="inline-flex flex-wrap gap-1">
            {([null, 0, 1, 2, 3, 4, 5, 6] as Array<number | null>).map((wd) => {
              const active = selWd === wd;
              return (
                <button
                  key={wd ?? 'all'}
                  type="button"
                  onClick={() => setSelWd(wd)}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                    active
                      ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                  }`}
                >
                  {wd == null ? 'Tất cả' : WEEKDAY_LABELS_VN[wd]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Đang xem: <strong>{formatSlotMonthLabel(effectiveSelMo)}</strong> ·{' '}
          <strong>{selWd == null ? 'tất cả các thứ' : WEEKDAY_LABELS_VN[selWd]}</strong> ·{' '}
          <strong>{selectedIndices.length}</strong> ngày vận hành ({firstSelectedDay} → {lastSelectedDay})
        </div>
      </div>

      {/* 2. 6 KPI Cards (#cards) */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">Số ngày trong phạm vi</div>
          <div className="mt-1 text-[22px] font-bold text-slate-900 dark:text-white">
            {kpiCards.daysCount}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">TB chuyến / ngày</div>
          <div className="mt-1 text-[22px] font-bold text-slate-900 dark:text-white">
            {kpiCards.avgFlightsPerDay}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">TB chuyến 2 slot / ngày</div>
          <div className="mt-1 text-[22px] font-bold text-slate-900 dark:text-white">
            {kpiCards.avgTwoSlotFlightsPerDay}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">Khung STD 15&apos; nhận code C</div>
          <div className="mt-1 text-[22px] font-bold text-emerald-600 dark:text-emerald-400">
            {kpiCards.pct15MinCodeC}%
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">Khung STD 15&apos; nhận code D/E</div>
          <div className="mt-1 text-[22px] font-bold text-emerald-600 dark:text-emerald-400">
            {kpiCards.pct15MinCodeDE}%
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Đỉnh nhu cầu TB (giờ đồng hồ, tham khảo)
          </div>
          <div
            className="mt-1 text-[20px] font-bold"
            style={{ color: COLOR_HEX[kpiCards.peakClockStatus] }}
          >
            {kpiCards.peakClockDemandAvg} lúc {kpiCards.peakClockTimeLabel}
          </div>
        </div>
      </div>

      {/* 3. Guide Card (💡 Hiểu đúng "Có thể nhận slot") */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          💡 Hiểu đúng &quot;Có thể nhận slot&quot;
        </h3>
        <div className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          👉 <b>Cách đọc:</b> muốn xét chuyến có STD = X → nhìn ngay cột/dòng <b>STD X</b> ở Biểu đồ 1 hoặc Bảng khung STD. Báo cáo đã tự kiểm tra toàn bộ thời gian chuyến đó chiếm slot (X−{P.slotBefore} → X−{P.slotAfter}), không cần rà ngược.
          <br />
          ✅ Chuyến code C cần còn ≥ 1 slot, chuyến code D/E cần còn ≥ 2 slot.
          <br />
          📊 Số liệu là <b>trung bình các ngày trong phạm vi</b> (làm tròn). Màu theo <b>% số ngày nhận được</b>:{' '}
          <span className="ml-1 inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            🟢 ≥ {P.okGreen}% ngày
          </span>{' '}
          <span className="ml-1 inline-block rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            🟡 {P.okAmber}–{P.okGreen}% ngày
          </span>{' '}
          <span className="ml-1 inline-block rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
            🔴 &lt; {P.okAmber}% ngày
          </span>
        </div>
      </div>

      {/* 4. Biểu đồ 1: STD khả thi (#c2) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          🎯 Biểu đồ 1: STD khả thi — chuyến cất cánh giờ X có nhận được slot không?
        </h3>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Trục ngang = giờ STD của chuyến cần xét (bước {P.step} phút). Chiều cao = số slot bị chiếm cao nhất (TB) trong thời gian chuyến đó chiếm slot. Màu = % ngày nhận được thêm 1 chuyến code C. Rê chuột để xem kết luận C / D/E.
        </div>
        <div className="mt-2 w-full">
          <canvas
            ref={feasCanvasRef}
            onMouseMove={handleFeasMouseMove}
            onMouseLeave={() => setTooltip(null)}
            className="block w-full cursor-crosshair"
          />
        </div>
      </div>

      {/* 5. Bảng khung STD 30 phút (#tb) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          📋 Bảng khung STD 30 phút — kết luận cho chuyến có STD trong khung
        </h3>
        <div className="mb-2.5 text-xs text-slate-500 dark:text-slate-400">
          Mỗi dòng = chuyến cần xét có STD trong khung. Khung 30 phút gồm 6 giờ STD (VD 14:00–14:25: 14:00, 14:05, …, 14:25); kết quả lấy theo giờ STD khó xếp nhất. 🟢 = cả 6 giờ STD đều xếp được; 🟡/🔴 = có ít nhất 1 giờ STD khó xếp, các giờ STD khác vẫn có thể xếp được. &quot;Chuyến trùng slot&quot; = các chuyến hiện có chiếm slot cùng lúc với chuyến cần xét.
        </div>

        <div className="max-h-[460px] overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <th className="p-1.5 text-left">Khung STD</th>
                <th className="p-1.5 text-center">Kết luận</th>
                <th className="p-1.5 text-center">Nhận C?</th>
                <th className="p-1.5 text-center">Nhận D/E?</th>
                <th className="p-1.5 text-center">Slot còn trống TB</th>
                <th className="p-1.5 text-center">% ngày nhận C</th>
                <th className="p-1.5 text-center">% ngày nhận D/E</th>
                <th className="p-1.5 text-center">Nhu cầu đỉnh TB</th>
                <th className="p-1.5 text-center">Nhu cầu đỉnh cao nhất</th>
                <th className="p-1.5 text-left">Chuyến trùng slot</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {table30Rows.map((row) => {
                const badgeClass =
                  row.status === 'green'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : row.status === 'amber'
                    ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                    : 'bg-rose-500/15 text-rose-700 dark:text-rose-300';

                return (
                  <tr key={row.rangeLabel} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-1.5 py-1.5 font-mono text-slate-900 dark:text-white">
                      {row.rangeLabel}
                    </td>
                    <td className="px-1.5 py-1.5 text-center">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeClass}`}>
                        {STATUS_LABEL_VN[row.status]}
                      </span>
                    </td>
                    <td className="px-1.5 py-1.5 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          row.canAcceptC
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {row.canAcceptC ? 'Có' : 'Không'}
                      </span>
                    </td>
                    <td className="px-1.5 py-1.5 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          row.canAcceptDE
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {row.canAcceptDE ? 'Có' : 'Không'}
                      </span>
                    </td>
                    <td className="px-1.5 py-1.5 text-center font-bold text-slate-900 dark:text-white">
                      {row.remainingAvg}
                    </td>
                    <td className="px-1.5 py-1.5 text-center">{row.pctC}%</td>
                    <td className="px-1.5 py-1.5 text-center">{row.pctDE}%</td>
                    <td className="px-1.5 py-1.5 text-center">{row.peakAvg}</td>
                    <td className="px-1.5 py-1.5 text-center">{row.peakMax}</td>
                    <td className="max-w-[420px] px-1.5 py-1.5 text-slate-500 dark:text-slate-400">
                      {row.overlappingFlightsText}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. Ma trận Tháng × Thứ (#mxb) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          🧮 Ma trận Tháng × Thứ — % khung STD 15&apos; nhận được code C
        </h3>
        <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Bấm vào ô để xem chi tiết tháng và thứ đó.
        </div>

        <div className="overflow-x-auto">
          <table className="w-full max-w-[760px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 dark:border-slate-700">
                <th className="p-1.5 text-left">Tháng</th>
                <th className="p-1.5 text-center">Tất cả</th>
                {WEEKDAY_LABELS_VN.map((w) => (
                  <th key={w} className="p-1.5 text-center">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([null, ...dataset.months] as Array<number | null>).map((mo) => (
                <tr key={mo ?? 'all'}>
                  <th className="p-1.5 text-left font-semibold text-slate-700 dark:text-slate-300">
                    {formatSlotMonthLabel(mo)}
                  </th>
                  {([null, 0, 1, 2, 3, 4, 5, 6] as Array<number | null>).map((wd) => {
                    const v = matrixMap.get(`${mo}|${wd}`);
                    if (v === undefined) {
                      return <td key={wd ?? 'all'} className="p-1.5" />;
                    }
                    const isSelected = effectiveSelMo === mo && selWd === wd;
                    const bgHsl = `hsl(${Math.round(v * 120)}, 70%, ${88 - v * 10}%)`;
                    return (
                      <td
                        key={wd ?? 'all'}
                        onClick={() => {
                          setSelMo(mo);
                          setSelWd(wd);
                          panelTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        style={{ backgroundColor: bgHsl }}
                        className={`cursor-pointer rounded-md border-2 border-white p-1.5 text-center font-semibold text-slate-900 dark:border-slate-900 ${
                          isSelected ? 'outline outline-2 outline-slate-900 dark:outline-white' : ''
                        }`}
                      >
                        {Math.round(v * 100)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 7. Tham khảo — theo giờ đồng hồ */}
      <h3 className="pt-2 text-sm font-semibold text-amber-800 dark:text-amber-400">
        📎 Tham khảo — theo giờ đồng hồ (không dùng trực tiếp để xét slot)
      </h3>

      {/* Biểu đồ 2: Nhu cầu theo giờ đồng hồ (#c1) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          📈 Nhu cầu theo giờ đồng hồ — số slot đang bị chiếm
        </h3>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Đường = nhu cầu TB (làm tròn), dải xám = thấp nhất–cao nhất trong phạm vi. Màu đường = % ngày còn &lt; {P.threshold} slot tại thời điểm đó. Lưu ý: giờ có nhu cầu thấp chưa chắc xếp được chuyến cất cánh vào giờ đó — xem Biểu đồ 1.
        </div>
        <div className="mt-2 w-full">
          <canvas
            ref={clockCanvasRef}
            onMouseMove={handleClockMouseMove}
            onMouseLeave={() => setTooltip(null)}
            className="block w-full cursor-crosshair"
          />
        </div>
      </div>

      {/* Biểu đồ 3: Aggregated Gantt Timeline (#c3) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          🗓️ Timeline — thời gian chiếm slot của các chuyến trong phạm vi
        </h3>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Mỗi thanh = 1 chuyến (số hiệu + giờ STD), chiếm slot từ STD−{P.slotBefore} đến STD−{P.slotAfter}. ▼ = STD. Viền đậm và &quot;×2&quot; = tàu 2 slot (code D/E). Màu = trạng thái xấu nhất theo nhu cầu giờ đồng hồ. Số ngày = số ngày khai thác / số ngày trong phạm vi.
        </div>
        <div className="mt-2 max-h-[620px] overflow-auto">
          <canvas
            ref={ganttCanvasRef}
            onMouseMove={handleGanttMouseMove}
            onMouseLeave={() => setTooltip(null)}
            className="block w-full"
          />
        </div>
      </div>

      {/* Floating Tooltip matching template.html #tip */}
      {tooltip && (
        <div
          style={{
            left: `${Math.min(tooltip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 330)}px`,
            top: `${tooltip.y + 14}px`,
          }}
          className="pointer-events-none fixed z-50 max-w-[320px] rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-slate-800 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <div className="font-bold">{tooltip.title}</div>
          {tooltip.statusColor && (
            <div style={{ color: COLOR_HEX[tooltip.statusColor] }} className="font-semibold">
              {STATUS_LABEL_VN[tooltip.statusColor]}
            </div>
          )}
          {tooltip.lines.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
          {tooltip.mutedLine && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{tooltip.mutedLine}</div>
          )}
        </div>
      )}
    </div>
  );
}
