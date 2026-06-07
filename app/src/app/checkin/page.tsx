'use client';

import {
  Suspense,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  getOperationalSettings,
  getSeasons,
} from '@/lib/remoteStore';
import {
  addCheckInCounter,
  allocateCheckInCounters,
  breakCheckInAllocation,
  buildCheckInAllocationView,
  buildCheckInPackedRows,
  buildCheckInPeriodUnallocationModifications,
  buildCheckInRecordProjection,
  buildCheckInResizePreview,
  buildCheckInTimelineTicks,
  calculateCheckInEdgeScroll,
  displayCheckInCounter,
  formatCheckInDisplayTime,
  formatCheckInFlightLabel,
  getCheckInColorToken,
  moveCheckInAllocation,
  mergeCheckInAllocationViewPatch,
  normalizeCheckInCounterList,
  overrideCheckInTimes,
  removeCheckInCounter,
  reshapeCheckInAllocation,
  resizeCheckInAllocation,
  unallocateCheckInRecord,
  type CheckInAllocationView,
  type CheckInColorToken,
  type CheckInCounter,
  type CheckInPackedItem,
  type CheckInResourceBar,
  type CheckInTimelineTicks,
} from '@/lib/checkinAllocation';
import { buildDefaultDailyDateRange, readDailyDateRangeQuery } from '@/lib/dailySchedule';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  getCachedSeasons,
  publishSeasonWorkspaceChanged,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  applyLocalModificationBatchDelta,
  type LocalSyncMeta,
} from '@/lib/localSeasonStore';
import { queryNativeAllocationWindow, runNativeLocalModificationBatchDeltaResult } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { trimUiUndoStack } from '@/lib/uiUndoMemory';
import {
  buildCheckInPdfPreviewPlan,
  exportCheckInAllocationPdf,
  renderCheckInPdfPageElement,
  selectCheckInPdfPreviewGroups,
  type CheckInPdfExportRange,
  type CheckInPdfPreviewPlan,
} from '@/lib/checkinPdfExport';
import { setSolidFlightBarDragImage } from '@/lib/flightBarDragImage';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import type { FlightModification, FlightRecord, OperationalSettings, Season } from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteActivity, useCachedRouteSearchParams } from '../components/RouteCacheContext';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import SeasonConflictReviewControl from '../components/SeasonConflictReviewControl';
import SyncActionButton from '../components/SyncActionButton';
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncGuard,
} from '../components/SeasonSyncProvider';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSessionState } from '../hooks/useSessionState';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';

const DEFAULT_TIMELINE_PIXELS_PER_MINUTE = 1.5;
const MIN_TIMELINE_PIXELS_PER_MINUTE = 0.5;
const MAX_TIMELINE_PIXELS_PER_MINUTE = 4;
const TIMELINE_ZOOM_STEP = 0.25;
const LABEL_COLUMN_WIDTH = 144;
const RESOURCE_ROW_HEIGHT = 36;
const BAR_HEIGHT = 24;
const MIN_BAR_WIDTH = 30;
const FULL_BAR_LABEL_WIDTH = 180;
const POOL_LANE_HEIGHT = 32;
const POOL_HEADER_HEIGHT = 36;
const POOL_MIN_HEIGHT = 86;
const POOL_MAX_HEIGHT = 260;
const EDGE_SCROLL_THRESHOLD = 64;
const EDGE_SCROLL_MAX_SPEED = 30;
const CHECKIN_PERFORMANCE_LOG_THRESHOLD_MS = 16;
const CHECKIN_COMMIT_DEBOUNCE_MS = 400;
const CHECKIN_SYNC_SUMMARY_DEBOUNCE_MS = 300;
const EMPTY_EXPORT_GROUP_IDS: string[] = [];

function getCheckInPerformanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function getAffectedIdsFromModifications(mods: FlightModification[]): string[] {
  return Array.from(new Set(mods.map((mod) => mod.legId)));
}

function buildCheckInWindowKey(fromDateTime: string, toDateTime: string): string {
  return `checkin:${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}`;
}

function logCheckInPerformance(label: string, startedAt: number, details: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'production') return;
  const durationMs = getCheckInPerformanceNow() - startedAt;
  if (durationMs < CHECKIN_PERFORMANCE_LOG_THRESHOLD_MS) return;
  console.debug('[checkin-performance]', label, {
    durationMs: Number(durationMs.toFixed(1)),
    ...details,
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatLocalDateTimeLabel(value: string): string {
  return value.replace('T', ' ');
}

function addDaysToLocalDateTime(value: string, days: number): string {
  const next = new Date(`${value}:00`);
  if (Number.isNaN(next.getTime())) return value;
  next.setDate(next.getDate() + days);
  const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
  return `${date}T${time}`;
}

function parseLocalDateTimeMs(value: string): number {
  return new Date(`${value}:00`).getTime();
}

function minutesBetweenLocal(left: string, right: string): number {
  return (parseLocalDateTimeMs(right) - parseLocalDateTimeMs(left)) / 60000;
}

function buildTimelineWidth(from: string, to: string, pixelsPerMinute: number): number {
  return Math.max(720, Math.ceil(minutesBetweenLocal(from, to) * pixelsPerMinute));
}

function clampTimelinePixelsPerMinute(value: number): number {
  return Math.min(MAX_TIMELINE_PIXELS_PER_MINUTE, Math.max(MIN_TIMELINE_PIXELS_PER_MINUTE, Number(value.toFixed(2))));
}

function buildCheckInSummary(view: CheckInAllocationView) {
  return {
    unallocated: view.unallocated.length,
    allocatedFlights: new Set(view.resourceBars.map((bar) => bar.recordId)).size,
    counterBlocks: view.resourceBars.length,
  };
}

function buildEffectiveRecord(record: FlightRecord, mod: FlightModification | undefined): FlightRecord | null {
  if (!mod) return record;
  if (mod.action === 'deleted') return null;
  if (mod.action === 'added' && mod.addedLeg) return { ...record, ...mod.addedLeg } as FlightRecord;
  return { ...record, ...mod } as FlightRecord;
}

function formatBarTitle(label: string, start: string, end: string, counter?: CheckInCounter): string {
  const counterLabel = counter == null ? '' : ` | Counter ${displayCheckInCounter(counter)}`;
  return `${label}${counterLabel} | ${formatLocalDateTimeLabel(start)} - ${formatLocalDateTimeLabel(end)}`;
}

function TimelineGridLines({ ticks }: { ticks: CheckInTimelineTicks }) {
  return (
    <>
      {ticks.minor.map((tick) => (
        <span
          key={tick.at}
          className="pointer-events-none absolute inset-y-0 border-l border-slate-200/70 dark:border-slate-800/80"
          style={{ left: `${tick.leftPercent}%` }}
        />
      ))}
    </>
  );
}

const TimelineGridBackground = memo(function TimelineGridBackground({ ticks }: { ticks: CheckInTimelineTicks }) {
  const minorStep = ticks.minor.length > 1
    ? Math.max(0.01, ticks.minor[1].leftPercent - ticks.minor[0].leftPercent)
    : 100;
  const majorStep = ticks.major.length > 1
    ? Math.max(minorStep, ticks.major[1].leftPercent - ticks.major[0].leftPercent)
    : minorStep * 4;
  return (
    <span
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: 'linear-gradient(to right, rgba(148, 163, 184, 0.42) 1px, transparent 1px), linear-gradient(to right, rgba(71, 85, 105, 0.5) 1px, transparent 1px)',
        backgroundSize: `${minorStep}% 100%, ${majorStep}% 100%`,
      }}
    />
  );
});

function TimelineHeader({
  ticks,
  timelineWidth,
  snapLineX,
  snapLineLabel,
}: {
  ticks: CheckInTimelineTicks;
  timelineWidth: number;
  snapLineX?: number | null;
  snapLineLabel?: string | null;
}) {
  return (
    <div className="sticky top-0 z-40 flex border-b border-surface-variant bg-surface-container-low text-on-surface-variant shadow-sm">
      <div
        className="sticky left-0 z-30 flex h-14 shrink-0 items-center border-r border-surface-variant bg-surface-container-low px-3 text-xs font-label-caps"
        style={{ width: LABEL_COLUMN_WIDTH }}
      >
        Timeline
      </div>
      <div className="relative h-14 shrink-0" style={{ width: timelineWidth }}>
        {snapLineX != null && snapLineLabel && (
          <span
            className="pointer-events-none absolute top-1 z-50 -translate-x-1/2 rounded bg-primary px-1.5 py-0.5 font-data-tabular text-[10px] font-semibold text-on-primary shadow-sm"
            style={{ left: snapLineX }}
          >
            {snapLineLabel}
          </span>
        )}
        <div className="absolute inset-x-0 top-0 h-7 border-b border-surface-variant/70">
          {ticks.macro.map((tick) => (
            <span
              key={tick.at}
              className="absolute top-1 whitespace-nowrap px-1 text-[11px] font-semibold"
              style={{ left: `${tick.leftPercent}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-7">
          {ticks.major.map((tick) => (
            <span
              key={tick.at}
              className="absolute bottom-1 border-l border-slate-400/70 px-1 text-[11px] font-data-tabular"
              style={{ left: `${tick.leftPercent}%` }}
            >
              {tick.label}
            </span>
          ))}
          <TimelineGridLines ticks={ticks} />
        </div>
      </div>
    </div>
  );
}

type DragState =
  | {
      kind: 'unallocated';
      recordId: string;
      dropSpan: number;
      startClientX: number;
    }
  | {
      kind: 'allocated';
      recordId: string;
      counter: CheckInCounter;
      counterIndex: number;
      groupStartIndex: number;
      dragRowOffset: number;
      dropSpan: number;
      mode: CheckInResourceBar['mode'];
      startClientX: number;
    };

function resolveDropTargetRow(drag: DragState | null, hoveredRowIndex: number, view: CheckInAllocationView) {
  const dropSpan = Math.max(1, drag?.dropSpan ?? 1);
  const dragRowOffset = drag?.kind === 'allocated' ? drag.dragRowOffset : 0;
  const maxPreviewStartRow = Math.max(0, view.resourceRows.length - dropSpan);
  const previewStartRow = Math.max(
    0,
    Math.min(
      maxPreviewStartRow,
      hoveredRowIndex - dragRowOffset
    )
  );
  const rowIndex = Math.max(
    0,
    Math.min(
      view.resourceRows.length - 1,
      previewStartRow + dragRowOffset
    )
  );
  return {
    rowIndex,
    previewStartRow,
    counter: view.resourceRows[rowIndex]?.counter ?? view.resourceRows[0]?.counter ?? 1,
  };
}

interface ContextMenuState {
  x: number;
  y: number;
  bar: CheckInResourceBar;
}

interface ResizeState {
  edge: 'start' | 'end';
  bar: CheckInResourceBar;
  startClientX: number;
  anchorX: number;
  anchorTime: string;
}

interface CheckInGroupedBarMetadata {
  groupedSpan: number;
  groupStartIndex: number;
}

interface CheckInResourceBarButtonProps {
  bar: CheckInResourceBar;
  color: CheckInColorToken;
  highlighted: boolean;
  left: number;
  width: number;
  groupedSpan: number;
  groupStartIndex: number;
  syncing: boolean;
  resizing: boolean;
  onDragStart: (
    event: DragEvent<HTMLDivElement>,
    bar: CheckInResourceBar,
    groupStartIndex: number,
    groupedSpan: number
  ) => void;
  onDragEnd: () => void;
  onHoverStart: (groupId: string) => void;
  onHoverEnd: (groupId: string) => void;
  onSelect: (groupId: string) => void;
  onOpenContextMenu: (bar: CheckInResourceBar, x: number, y: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, bar: CheckInResourceBar) => void;
  onResizeStart: (edge: ResizeState['edge'], bar: CheckInResourceBar, clientX: number) => void;
}

function isSameCheckInColorToken(left: CheckInColorToken, right: CheckInColorToken): boolean {
  return left.backgroundColor === right.backgroundColor &&
    left.borderColor === right.borderColor &&
    left.textColor === right.textColor &&
    left.focusColor === right.focusColor;
}

function areCheckInResourceBarButtonPropsEqual(
  previous: CheckInResourceBarButtonProps,
  next: CheckInResourceBarButtonProps
): boolean {
  return previous.bar === next.bar &&
    previous.highlighted === next.highlighted &&
    previous.left === next.left &&
    previous.width === next.width &&
    previous.groupedSpan === next.groupedSpan &&
    previous.groupStartIndex === next.groupStartIndex &&
    previous.syncing === next.syncing &&
    previous.resizing === next.resizing &&
    isSameCheckInColorToken(previous.color, next.color) &&
    previous.onDragStart === next.onDragStart &&
    previous.onDragEnd === next.onDragEnd &&
    previous.onHoverStart === next.onHoverStart &&
    previous.onHoverEnd === next.onHoverEnd &&
    previous.onSelect === next.onSelect &&
    previous.onOpenContextMenu === next.onOpenContextMenu &&
    previous.onKeyDown === next.onKeyDown &&
    previous.onResizeStart === next.onResizeStart;
}

const CheckInResourceBarButton = memo(function CheckInResourceBarButton({
  bar,
  color,
  highlighted,
  left,
  width,
  groupedSpan,
  groupStartIndex,
  syncing,
  resizing,
  onDragStart,
  onDragEnd,
  onHoverStart,
  onHoverEnd,
  onSelect,
  onOpenContextMenu,
  onKeyDown,
  onResizeStart,
}: CheckInResourceBarButtonProps) {
  const isFullLabel = bar.labelMode === 'full';
  const isCompactLabel = bar.labelMode === 'compact';
  const isFlightOnlyLabel = bar.labelMode === 'flightOnly';
  const isBrokenShape = bar.mode === 'broken';
  const lockConflict = bar.lockConflict;
  const title = lockConflict
    ? `${formatBarTitle(bar.flightNumber, bar.start, bar.end, bar.counter)} | LockConflict ${lockConflict.lock.name}`
    : formatBarTitle(bar.flightNumber, bar.start, bar.end, bar.counter);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${bar.flightNumber} on counter ${displayCheckInCounter(bar.counter)}, ${formatLocalDateTimeLabel(bar.start)} to ${formatLocalDateTimeLabel(bar.end)}${lockConflict ? `, LockConflict ${lockConflict.lock.name}` : ''}`}
      draggable={!syncing && !resizing}
      onDragStart={(event) => onDragStart(event, bar, groupStartIndex, groupedSpan)}
      onDragEnd={onDragEnd}
      onMouseEnter={() => onHoverStart(bar.groupId)}
      onMouseLeave={() => onHoverEnd(bar.groupId)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(bar.groupId);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenContextMenu(bar, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => onKeyDown(event, bar)}
      className={`absolute flex h-6 cursor-grab items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold transition-[transform,width,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing ${highlighted ? 'z-20' : 'z-10'} ${lockConflict ? 'ring-2 ring-error/80 ring-offset-1 ring-offset-surface-container-lowest' : ''}`}
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${left}px, ${6 + bar.stackIndex * (BAR_HEIGHT + 4)}px, 0)`,
        width,
        height: BAR_HEIGHT,
        background: color.backgroundColor,
        backgroundColor: color.backgroundColor,
        backgroundImage: 'none',
        border: isBrokenShape ? '1px dashed #FFFFFF' : '1px solid #FFFFFF',
        borderRadius: 4,
        color: color.textColor,
        opacity: 1,
        boxShadow: highlighted ? `0 0 0 2px ${color.focusColor}` : 'none',
      }}
      title={title}
    >
      <button
        type="button"
        aria-label="Resize start"
        disabled={syncing}
        draggable={false}
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize disabled:cursor-not-allowed"
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          event.preventDefault();
          onResizeStart('start', bar, event.clientX);
        }}
      />
      <span
        className={`min-w-0 truncate ${isFullLabel
          ? 'w-full px-10 text-center'
          : isCompactLabel
            ? 'w-full px-8 text-center text-[10px]'
            : 'px-1'}`}
      >
        {bar.flightNumber}
      </span>
      {!isFlightOnlyLabel && (
        <>
          <span className={`pointer-events-none absolute top-0.5 font-data-tabular font-semibold opacity-80 ${isCompactLabel ? 'left-1 text-[8px]' : 'left-2 text-[10px]'}`}>
            {bar.startLabel}
          </span>
          <span className={`pointer-events-none absolute top-0.5 font-data-tabular font-semibold opacity-80 ${isCompactLabel ? 'right-1 text-[8px]' : 'right-2 text-[10px]'}`}>
            {bar.endLabel}
          </span>
        </>
      )}
      {lockConflict && (
        <span
          className="material-symbols-outlined pointer-events-none absolute bottom-0.5 right-3 text-[11px] text-error"
          title={`LockConflict ${lockConflict.lock.name}`}
        >
          lock
        </span>
      )}
      <button
        type="button"
        aria-label="Resize end"
        disabled={syncing}
        draggable={false}
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize disabled:cursor-not-allowed"
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          event.preventDefault();
          onResizeStart('end', bar, event.clientX);
        }}
      />
    </div>
  );
}, areCheckInResourceBarButtonPropsEqual);

interface OverrideDraft {
  recordId: string;
  flightLabel: string;
  counter: CheckInCounter;
  start: string;
  end: string;
}

type CheckInLocalCommitWorkerResponse =
  | {
      requestId: number;
      ok: true;
      syncMeta?: LocalSyncMeta;
      affectedIds?: string[];
    }
  | {
      requestId: number;
      ok: false;
      message: string;
    };

interface PendingCheckInCommitRequest {
  resolve: (response: Extract<CheckInLocalCommitWorkerResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
}

interface CheckInCommitOptions {
  trackUndo?: boolean;
}

type CheckInCommitPersistenceResult = {
  syncMeta?: LocalSyncMeta;
  affectedIds?: string[];
  source?: 'checkin' | 'checkin-worker' | 'checkin-native';
};

interface CheckInUndoEntry {
  id: number;
  description: string;
  mods: FlightModification[];
}

interface PendingAccumulatedCheckInCommit {
  legIds: string[];
  mods: FlightModification[];
  description: string;
  undoEntry: CheckInUndoEntry | null;
  trackUndo: boolean;
}

type CheckInExportDraft = CheckInPdfExportRange & {
  selectedGroupIds: string[];
};

function cloneCheckInCounterValue(counter: FlightRecord['counter']): FlightModification['counter'] {
  if (Array.isArray(counter)) return [...counter];
  if (counter && typeof counter === 'object') {
    return Object.fromEntries(Object.entries(counter).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]));
  }
  return counter ?? null;
}

function cloneCheckInCounterWindows(windows: FlightRecord['checkInCounterWindows']): FlightModification['checkInCounterWindows'] {
  if (!windows) return null;
  return Object.fromEntries(Object.entries(windows).map(([counter, window]) => [
    counter,
    { ...window },
  ]));
}

function buildCheckInUndoModification(record: FlightRecord): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    counter: cloneCheckInCounterValue(record.counter),
    checkInStart: record.checkInStart ?? null,
    checkInEnd: record.checkInEnd ?? null,
    checkInAllocationMode: record.checkInAllocationMode ?? null,
    checkInCounterWindows: cloneCheckInCounterWindows(record.checkInCounterWindows),
    bhs: record.bhs ?? null,
  };
}

function shouldIgnoreCheckInUndoShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function getResourceRowStripeClass(rowIndex: number, isDropTarget: boolean) {
  if (isDropTarget) {
    return {
      rowStripeClass: 'bg-primary-container/25',
      labelStripeClass: 'bg-primary-container/35',
    };
  }
  const isEvenRow = rowIndex % 2 === 0;
  return {
    rowStripeClass: isEvenRow ? 'bg-surface-container-lowest' : 'bg-surface-container-low/60',
    labelStripeClass: isEvenRow ? 'bg-surface-container-lowest' : 'bg-surface-container-low',
  };
}

function isValidCheckInExportRange(range: CheckInPdfExportRange): boolean {
  if (!range.from || !range.to) return false;
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && to > from;
}

function buildCheckInPdfFileName(seasonCode: string, range: CheckInPdfExportRange): string {
  const clean = (value: string) => value.replace(/[-:]/g, '').replace('T', '_');
  const safeSeasonCode = seasonCode.replace(/[^A-Za-z0-9_-]+/g, '_') || 'Season';
  return `CheckIn_Allocation_${safeSeasonCode}_${clean(range.from)}_${clean(range.to)}.pdf`;
}

function CheckInPdfPreviewPanel({
  error,
  preview,
  records,
  seasonCode,
}: {
  error: string | null;
  preview: CheckInPdfPreviewPlan | null;
  records: FlightRecord[];
  seasonCode: string;
}) {
  const previewPageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!preview || preview.pages.length === 0) return;
    const pageRefs = previewPageRefs.current;
    const renderPreviewPages = () => {
      for (const page of preview.pages) {
        const pageKey = `${page.sectionId}-${page.pageIndex}`;
        const host = pageRefs.get(pageKey);
        if (!host) continue;
        host.replaceChildren();
        const pageElement = renderCheckInPdfPageElement({
          preview,
          page,
          records,
          seasonCode,
        });
        const hostWidth = Math.max(1, host.clientWidth);
        const hostHeight = Math.max(1, host.clientHeight);
        const previewScale = Math.min(hostWidth / page.sourceWidthPx, hostHeight / page.sourceHeightPx);
        Object.assign(pageElement.style, {
          pointerEvents: 'none',
          transform: `scale(${previewScale})`,
          transformOrigin: 'top left',
        });
        host.appendChild(pageElement);
      }
    };

    let animationFrame: number | null = null;
    const scheduleRenderPreviewPages = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        renderPreviewPages();
      });
    };
    scheduleRenderPreviewPages();
    const resizeObservers: ResizeObserver[] = [];
    if (typeof ResizeObserver !== 'undefined') {
      for (const host of pageRefs.values()) {
        const observer = new ResizeObserver(scheduleRenderPreviewPages);
        observer.observe(host);
        resizeObservers.push(observer);
      }
    }

    return () => {
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
      resizeObservers.forEach((observer) => observer.disconnect());
      pageRefs.forEach((host) => host.replaceChildren());
    };
  }, [preview, records, seasonCode]);

  if (error) {
    return (
      <div className="flex min-h-72 items-center justify-center rounded border border-error/40 bg-error-container/30 p-6 text-center text-sm text-on-error-container">
        {error}
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex min-h-72 items-center justify-center rounded border border-surface-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
        Configure an export range to generate the PDF Preview.
      </div>
    );
  }
  if (preview.pages.length === 0) {
    return (
      <div className="flex min-h-72 items-center justify-center rounded border border-surface-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
        Select at least one Counter Group to preview the final PDF pages.
      </div>
    );
  }

  return (
    <div className="grid min-h-0 min-w-0 gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">PDF Preview</h3>
          <p className="text-xs text-on-surface-variant">
            {preview.pages.length} page{preview.pages.length === 1 ? '' : 's'} - A4 landscape - fit-to-page
          </p>
        </div>
        <span className="min-w-0 truncate rounded border border-surface-variant bg-surface-container px-2 py-1 text-xs font-semibold text-on-surface-variant">
          {formatLocalDateTimeLabel(preview.range.from)} - {formatLocalDateTimeLabel(preview.range.to)}
        </span>
      </div>
      <div className="grid max-h-[calc(100vh-190px)] min-w-0 gap-4 overflow-auto rounded border border-surface-variant bg-surface-container-low p-3">
        {preview.pages.map((page) => (
          <section key={`${page.sectionId}-${page.pageIndex}`} className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-variant">
              <span className="font-semibold text-on-surface">
                Page {page.pageIndex + 1}: {page.sectionName}
              </span>
              <span>
                {page.scaleMode === 'width' ? 'Width fit' : 'Height fit'} - bar text {page.barFontSizePt.toFixed(1)}pt
              </span>
            </div>
            {page.warning && (
              <div className="rounded border border-error/40 bg-error-container/30 px-3 py-2 text-xs text-on-error-container">
                {page.warning}
              </div>
            )}
            <div className="relative aspect-[297/210] w-full min-w-0 overflow-hidden rounded border border-slate-300 bg-white text-slate-900 shadow-sm">
              <div
                className="absolute overflow-hidden"
                ref={(node) => {
                  const pageKey = `${page.sectionId}-${page.pageIndex}`;
                  if (node) previewPageRefs.current.set(pageKey, node);
                  else previewPageRefs.current.delete(pageKey);
                }}
                style={{
                  left: `${(page.marginMm / page.pageWidthMm) * 100}%`,
                  top: `${(page.marginMm / page.pageHeightMm) * 100}%`,
                  width: `${(page.outputWidthMm / page.pageWidthMm) * 100}%`,
                  height: `${(page.outputHeightMm / page.pageHeightMm) * 100}%`,
                }}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function CheckInAllocationContent() {
  const router = useRouter();
  const searchParams = useCachedRouteSearchParams();
  const isRouteActive = useCachedRouteActivity();
  const { dialogNode, showAlert } = useAppDialog();
  const { notifyExportCompleted } = useExportNotifications();
  const targetSeasonId = searchParams.get('season');
  const requestedRange = readDailyDateRangeQuery(searchParams);
  const defaultRange = requestedRange ?? buildDefaultDailyDateRange(todayIso());

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [season, setSeason] = useState<Season | null>(null);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>([]);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [optimisticAllocationView, setOptimisticAllocationView] = useState<CheckInAllocationView | null>(null);
  const [settings, setSettings] = useState<OperationalSettings | null>(null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    lastLocalChangeAt: null,
  });
  const [fromDateTime, setFromDateTime] = useSessionState('checkin:fromDateTime', defaultRange.from);
  const [toDateTime, setToDateTime] = useSessionState('checkin:toDateTime', defaultRange.to);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading check-in allocation...', 10, 'Preparing workspace')
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<OverrideDraft | null>(null);
  const [exportDraft, setExportDraft] = useState<CheckInExportDraft | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [poolHeight, setPoolHeight] = useSessionState('checkin:poolHeight', 150);
  const [poolCollapsed, setPoolCollapsed] = useSessionState('checkin:poolCollapsed', false);
  const [activeDropRowIndex, setActiveDropRowIndex] = useState<number | null>(null);
  const [activeDropSpan, setActiveDropSpan] = useState(1);
  const [poolDropActive, setPoolDropActive] = useState(false);
  const [snapLineX, setSnapLineX] = useState<number | null>(null);
  const [snapLineLabel, setSnapLineLabel] = useState<string | null>(null);
  const [isGanttFullscreen, setIsGanttFullscreen] = useState(false);
  const [timelinePixelsPerMinute, setTimelinePixelsPerMinute] = useSessionState(
    'checkin:timelinePixelsPerMinute',
    DEFAULT_TIMELINE_PIXELS_PER_MINUTE
  );
  const [groupByCounterGroup, setGroupByCounterGroup] = useSessionState('checkin:groupByCounterGroup', true);
  const dragStateRef = useRef<DragState | null>(null);
  const resizeDragGuardRef = useRef(false);
  const ganttScrollRef = useRef<HTMLDivElement | null>(null);
  const ganttFullscreenRef = useRef<HTMLElement | null>(null);
  const snapLineAnimationFrameRef = useRef<number | null>(null);
  const pendingSnapLineClientXRef = useRef<number | null>(null);
  const dropPreviewAnimationFrameRef = useRef<number | null>(null);
  const pendingDropPreviewRowRef = useRef<number | null>(null);
  const checkInCommitWorkerRef = useRef<Worker | null>(null);
  const checkInCommitRequestsRef = useRef(new Map<number, PendingCheckInCommitRequest>());
  const checkInCommitRequestSeqRef = useRef(0);
  const checkInUndoStackRef = useRef<CheckInUndoEntry[]>([]);
  const checkInUndoSeqRef = useRef(0);
  const latestCheckInModificationsRef = useRef(modifications);
  const optimisticAllocationViewRef = useRef<CheckInAllocationView | null>(null);
  const checkInCommitAccumulatorRef = useRef<PendingAccumulatedCheckInCommit | null>(null);
  const checkInCommitFlushTimerRef = useRef<number | null>(null);
  const pendingCheckInSyncSummaryRef = useRef<Pick<LocalSyncMeta, 'pendingCount' | 'lastLocalChangeAt'> | null>(null);
  const checkInSyncSummaryTimerRef = useRef<number | null>(null);
  const commitQueueRef = useRef(Promise.resolve());
  const currentMutationRef = useRef<Promise<unknown> | null>(null);
  const historySeqRef = useRef(0);
  const appliedRangeQueryRef = useRef<string | null>(null);
  useSessionScrollRestoration('checkin:gantt-scroll', ganttScrollRef);
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow, fetchUpdatesNow } = useSeasonSync(syncSeasonId, 'checkin');
  const syncing = syncStatus.status === 'syncing' && syncStatus.mode === 'manual';
  const fetchingUpdates = syncStatus.status === 'catching_up' && syncStatus.mode === 'manual';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' || syncStatus.status === 'conflict' ? syncStatus.message : null);
  const fetchProgress = fetchingUpdates ? syncStatus.progress ?? syncStatus.message : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);

  const waitForCheckInLocalCommit = useCallback(async () => {
    await currentMutationRef.current;
  }, []);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'checkin', {
    blocked: Boolean(draggedGroupId) || resizeState !== null,
    reason: resizeState ? 'Resizing check-in allocation' : draggedGroupId ? 'Dragging check-in allocation' : undefined,
    beforeSync: waitForCheckInLocalCommit,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'checkin-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
    quiet: true,
    blockingUi: false,
  });

  const clearOptimisticAllocationView = useCallback(() => {
    optimisticAllocationViewRef.current = null;
    setOptimisticAllocationView(null);
  }, []);

  const clearCheckInUndoStack = useCallback(() => {
    checkInUndoStackRef.current = [];
  }, []);

  useEffect(() => {
    const clearOnPageExit = () => clearCheckInUndoStack();
    window.addEventListener('pagehide', clearOnPageExit);
    window.addEventListener('beforeunload', clearOnPageExit);
    return () => {
      window.removeEventListener('pagehide', clearOnPageExit);
      window.removeEventListener('beforeunload', clearOnPageExit);
    };
  }, [clearCheckInUndoStack]);

  const clearCheckInCommitAccumulator = useCallback(() => {
    if (checkInCommitFlushTimerRef.current != null) {
      window.clearTimeout(checkInCommitFlushTimerRef.current);
      checkInCommitFlushTimerRef.current = null;
    }
    checkInCommitAccumulatorRef.current = null;
    pendingCheckInSyncSummaryRef.current = null;
    if (checkInSyncSummaryTimerRef.current != null) {
      window.clearTimeout(checkInSyncSummaryTimerRef.current);
      checkInSyncSummaryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!requestedRange) {
      appliedRangeQueryRef.current = null;
      return;
    }

    const rangeKey = `${requestedRange.from}|${requestedRange.to}`;
    if (appliedRangeQueryRef.current === rangeKey) return;
    clearOptimisticAllocationView();
    setFromDateTime(requestedRange.from);
    setToDateTime(requestedRange.to);
    appliedRangeQueryRef.current = rangeKey;
  }, [clearOptimisticAllocationView, requestedRange, setFromDateTime, setToDateTime]);

  const replaceCheckInModifications = useCallback((
    nextModifications: Map<string, FlightModification>,
    options: { render?: boolean } = {}
  ) => {
    if (options.render === false) {
      latestCheckInModificationsRef.current = nextModifications;
      return;
    }
    latestCheckInModificationsRef.current = new Map(nextModifications);
    setModifications(new Map(nextModifications));
  }, []);

  const promoteLatestCheckInModificationsForView = useCallback(() => {
    const latestModifications = new Map(latestCheckInModificationsRef.current);
    latestCheckInModificationsRef.current = new Map(latestModifications);
    setModifications(latestModifications);
  }, []);

  const publishWorkspaceChange = useCallback((
    seasonId: string,
    localRevision: number | null,
    source: 'checkin' | 'checkin-worker' | 'checkin-native' | 'checkin-sync',
    affectedIds: string[] = [],
    syncMeta: LocalSyncMeta | null = null
  ) => {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision,
      source,
      affectedIds,
      syncMeta,
    });
  }, []);

  const refreshCheckInWindow = useCallback(async () => {
    if (!season) return;
    const result = await queryNativeAllocationWindow({
      seasonId: season.id,
      dateFrom: fromDateTime.slice(0, 10),
      dateTo: toDateTime.slice(0, 10),
      resourceType: 'checkin',
      limit: 10000,
    });
    if (!result) throw new Error('Native allocation query is unavailable.');
    const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
    clearOptimisticAllocationView();
    setFlightRecords(result.records);
    replaceCheckInModifications(nextModifications);
    setSyncSummary({
      pendingCount: result.syncMeta.pendingCount,
      lastLocalChangeAt: result.syncMeta.lastLocalChangeAt,
    });
    setCachedSeasonData(season.id, {
      rows: [],
      records: result.records,
      modifications: nextModifications,
      seasonDataVersion: season.dataVersion,
    });
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: season.id,
      season,
      rows: [],
      records: result.records,
      modifications: nextModifications,
      syncMeta: result.syncMeta,
      windowKey: buildCheckInWindowKey(fromDateTime, toDateTime),
    });
  }, [clearOptimisticAllocationView, fromDateTime, replaceCheckInModifications, season, toDateTime]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'checkin',
    onNativeRefresh: async () => {
      await refreshCheckInWindow();
    },
  });

  const enqueueLocalMutation = useCallback(function enqueueLocalMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queuedMutation = commitQueueRef.current.then(operation);
    currentMutationRef.current = queuedMutation;
    void queuedMutation.then(() => {
      if (currentMutationRef.current === queuedMutation) currentMutationRef.current = null;
    }, () => {
      if (currentMutationRef.current === queuedMutation) currentMutationRef.current = null;
    });
    commitQueueRef.current = queuedMutation.then(() => undefined, () => undefined);
    return queuedMutation;
  }, []);

  const commitCheckInModificationsOnMainThread = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<CheckInCommitPersistenceResult> => {
    if (mods.length === 0) return {};
    const affectedIds = getAffectedIdsFromModifications(mods);
    return enqueueLocalMutation(async () => {
      const performanceStartedAt = getCheckInPerformanceNow();
      const timestamp = Date.now();
      const syncMeta = await applyLocalModificationBatchDelta(seasonId, mods, {
        id: `LOCAL_CHECKIN_${timestamp}_${++historySeqRef.current}`,
        timestamp,
        description,
      });
      logCheckInPerformance('commitCheckInModifications', performanceStartedAt, {
        modCount: mods.length,
        pendingCount: syncMeta.pendingCount,
      });
      return {
        syncMeta,
        affectedIds,
        source: 'checkin',
      };
    });
  }, [enqueueLocalMutation]);

  const commitCheckInModificationsNative = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<CheckInCommitPersistenceResult | null> => {
    if (mods.length === 0) return {};
    return enqueueLocalMutation(async () => {
      const performanceStartedAt = getCheckInPerformanceNow();
      const timestamp = Date.now();
      const nativeResult = await runNativeLocalModificationBatchDeltaResult(seasonId, mods, {
        id: `LOCAL_CHECKIN_${timestamp}_${++historySeqRef.current}`,
        timestamp,
        description,
      });
      if (!nativeResult) return null;
      logCheckInPerformance('commitCheckInModifications', performanceStartedAt, {
        modCount: mods.length,
        pendingCount: nativeResult.syncMeta.pendingCount,
        native: true,
      });
      return {
        syncMeta: nativeResult.syncMeta,
        affectedIds: nativeResult.affectedIds,
        source: 'checkin-native',
      };
    });
  }, [enqueueLocalMutation]);

  const getCheckInCommitWorker = useCallback((): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (checkInCommitWorkerRef.current) return checkInCommitWorkerRef.current;
    try {
      const worker = new Worker(new URL('./checkInLocalCommitWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<CheckInLocalCommitWorkerResponse>) => {
        const pending = checkInCommitRequestsRef.current.get(event.data.requestId);
        if (!pending) return;
        checkInCommitRequestsRef.current.delete(event.data.requestId);
        if (event.data.ok) {
          pending.resolve(event.data);
        } else {
          pending.reject(new Error(event.data.message));
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || 'Check-in local commit worker failed.');
        for (const pending of checkInCommitRequestsRef.current.values()) pending.reject(error);
        checkInCommitRequestsRef.current.clear();
        checkInCommitWorkerRef.current?.terminate();
        checkInCommitWorkerRef.current = null;
      };
      checkInCommitWorkerRef.current = worker;
      return worker;
    } catch {
      checkInCommitWorkerRef.current = null;
      return null;
    }
  }, []);

  const commitCheckInModificationsInWorker = useCallback((
    worker: Worker,
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<Extract<CheckInLocalCommitWorkerResponse, { ok: true }>> => {
    const requestId = ++checkInCommitRequestSeqRef.current;
    const requestPromise = new Promise<Extract<CheckInLocalCommitWorkerResponse, { ok: true }>>((resolve, reject) => {
      checkInCommitRequestsRef.current.set(requestId, { resolve, reject });
    });
    worker.postMessage({
      type: 'commit',
      requestId,
      seasonId,
      mods,
      description,
    });
    return requestPromise;
  }, []);

  const warmupCheckInCommitWorker = useCallback((seasonId: string): void => {
    const worker = getCheckInCommitWorker();
    if (!worker) return;
    const requestId = ++checkInCommitRequestSeqRef.current;
    const requestPromise = new Promise<Extract<CheckInLocalCommitWorkerResponse, { ok: true }>>((resolve, reject) => {
      checkInCommitRequestsRef.current.set(requestId, { resolve, reject });
    });
    worker.postMessage({
      type: 'warmup',
      requestId,
      seasonId,
    });
    void requestPromise.catch(() => undefined);
  }, [getCheckInCommitWorker]);

  const persistCheckInModifications = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<CheckInCommitPersistenceResult> => {
    if (mods.length === 0) return {};
    const nativeResult = await commitCheckInModificationsNative(seasonId, mods, description);
    if (nativeResult) return nativeResult;
    const worker = getCheckInCommitWorker();
    if (!worker) {
      return commitCheckInModificationsOnMainThread(seasonId, mods, description);
    }
    return (async () => {
      const performanceStartedAt = getCheckInPerformanceNow();
      const response = await commitCheckInModificationsInWorker(worker, seasonId, mods, description);
      logCheckInPerformance('commitCheckInModifications', performanceStartedAt, {
        modCount: mods.length,
        pendingCount: response.syncMeta?.pendingCount ?? null,
        worker: true,
      });
      return {
        syncMeta: response.syncMeta,
        affectedIds: response.affectedIds ?? getAffectedIdsFromModifications(mods),
        source: 'checkin-worker',
      };
    })();
  }, [commitCheckInModificationsInWorker, commitCheckInModificationsNative, commitCheckInModificationsOnMainThread, getCheckInCommitWorker]);

  useEffect(() => {
    if (!isRouteActive || !season?.id) return undefined;
    let cancelled = false;
    const runWarmup = () => {
      if (!cancelled) warmupCheckInCommitWorker(season.id);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(runWarmup, { timeout: 1500 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idleId);
      };
    }
    const timeoutId = window.setTimeout(runWarmup, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isRouteActive, season?.id, warmupCheckInCommitWorker]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Loading seasons and settings', 15, 'Preparing check-in allocation'));
      try {
        const [cachedSeasons, loadedSettings] = await Promise.all([
          Promise.resolve(getCachedSeasons()),
          getOperationalSettings(),
        ]);
        const nextSeasons = cachedSeasons ?? await getSeasons();
        if (cancelled) return;
        if (!cachedSeasons) setCachedSeasons(nextSeasons);
        setSettings(loadedSettings);
        setSeasons(nextSeasons);
        useSeasonWorkspaceStore.getState().setOperationalSettings(loadedSettings);
        useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);

        if (nextSeasons.length === 0) {
          clearOptimisticAllocationView();
          clearCheckInUndoStack();
          setSeason(null);
          setFlightRecords([]);
          replaceCheckInModifications(new Map());
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          return;
        }

        const targetSeason = nextSeasons.find((item) => item.id === targetSeasonId) ?? nextSeasons[0];
        if (!targetSeasonId || targetSeasonId !== targetSeason.id) {
          router.replace(`/checkin?season=${targetSeason.id}`);
          return;
        }

        setLoadProgress(buildLoadProgress('Checking local season baseline', 30, targetSeason.seasonCode));
        await ensureNativeSeasonBaseline(targetSeason);
        if (cancelled) return;
        setLoadProgress(buildLoadProgress('Querying native SQLite', 45, targetSeason.seasonCode));
        const result = await queryNativeAllocationWindow({
          seasonId: targetSeason.id,
          dateFrom: fromDateTime.slice(0, 10),
          dateTo: toDateTime.slice(0, 10),
          resourceType: 'checkin',
          limit: 10000,
        });
        if (cancelled) return;
        if (!result) throw new Error('Native allocation query is unavailable.');
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setLoadProgress(buildLoadProgress(
          'Preparing Check-in Allocation',
          80,
          `${result.records.length} records`
        ));
        setSeason(targetSeason);
        setFlightRecords(result.records);
        replaceCheckInModifications(nextModifications);
        setSyncSummary({
          pendingCount: result.syncMeta.pendingCount,
          lastLocalChangeAt: result.syncMeta.lastLocalChangeAt,
        });
        setCachedSeasonData(targetSeason.id, {
          rows: [],
          records: result.records,
          modifications: nextModifications,
          seasonDataVersion: targetSeason.dataVersion,
        });
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: targetSeason.id,
          season: targetSeason,
          rows: [],
          records: result.records,
          modifications: nextModifications,
          syncMeta: result.syncMeta,
          windowKey: buildCheckInWindowKey(fromDateTime, toDateTime),
        });
      } catch (err) {
        const message = (err as Error).message;
        console.error('Error loading check-in allocation', err);
        if (!cancelled) {
          setLoadError(message);
          void showAlert({ title: 'Load Failed', message, tone: 'error' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearCheckInUndoStack, clearOptimisticAllocationView, fromDateTime, replaceCheckInModifications, router, showAlert, targetSeasonId, toDateTime]);

  const allocationResult = useMemo(() => {
    if (!settings) return { view: null, error: null };
    try {
      const performanceStartedAt = getCheckInPerformanceNow();
      const view = buildCheckInAllocationView({
        records: flightRecords,
        modifications,
        settings,
        from: fromDateTime,
        to: toDateTime,
        groupByCounterGroup,
        pixelsPerMinute: timelinePixelsPerMinute,
      });
      logCheckInPerformance('buildCheckInAllocationView', performanceStartedAt, {
        records: flightRecords.length,
        modifications: modifications.size,
        resourceBars: view.resourceBars.length,
        unallocated: view.unallocated.length,
      });
      return {
        view,
        error: null,
      };
    } catch (err) {
      return { view: null, error: (err as Error).message };
    }
  }, [flightRecords, fromDateTime, groupByCounterGroup, modifications, settings, timelinePixelsPerMinute, toDateTime]);

  const displayAllocationView = optimisticAllocationView ?? allocationResult.view;

  useEffect(() => {
    if (optimisticAllocationViewRef.current) clearOptimisticAllocationView();
  }, [allocationResult.view, clearOptimisticAllocationView]);

  const timeline = useMemo(() => {
    try {
      return {
        ticks: buildCheckInTimelineTicks(fromDateTime, toDateTime),
        width: buildTimelineWidth(fromDateTime, toDateTime, timelinePixelsPerMinute),
        error: null,
      };
    } catch (err) {
      return {
        ticks: null,
        width: 720,
        error: (err as Error).message,
      };
    }
  }, [fromDateTime, timelinePixelsPerMinute, toDateTime]);

  const exportDraftFrom = exportDraft?.from ?? null;
  const exportDraftTo = exportDraft?.to ?? null;
  const exportSelectedGroupIds = exportDraft?.selectedGroupIds ?? EMPTY_EXPORT_GROUP_IDS;
  const deferredExportSelectedGroupIds = useDeferredValue(exportSelectedGroupIds);
  const exportBasePreviewResult = useMemo(() => {
    if (!exportDraftFrom || !exportDraftTo || !settings) return { preview: null, error: null };
    try {
      return {
        preview: buildCheckInPdfPreviewPlan({
          records: flightRecords,
          modifications,
          settings,
          range: {
            from: exportDraftFrom,
            to: exportDraftTo,
          },
        }),
        error: null,
      };
    } catch (err) {
      return {
        preview: null,
        error: (err as Error).message,
      };
    }
  }, [exportDraftFrom, exportDraftTo, flightRecords, modifications, settings]);
  const exportPreview = useMemo(() => (
    exportBasePreviewResult.preview
      ? selectCheckInPdfPreviewGroups(exportBasePreviewResult.preview, deferredExportSelectedGroupIds)
      : null
  ), [deferredExportSelectedGroupIds, exportBasePreviewResult.preview]);
  const exportPreviewError = exportBasePreviewResult.error;
  const exportGroups = exportBasePreviewResult.preview?.availableGroups ?? [];
  const canExportPdf = Boolean(
    exportDraft &&
      exportSelectedGroupIds.length > 0 &&
      !exportPreviewError &&
      isValidCheckInExportRange(exportDraft) &&
      !exportingPdf
  );

  const summary = useMemo(() => (
    displayAllocationView
      ? buildCheckInSummary(displayAllocationView)
      : { unallocated: 0, allocatedFlights: 0, counterBlocks: 0 }
  ), [displayAllocationView]);

  const packedUnallocated = useMemo(() => {
    if (!displayAllocationView) return { laneCount: 0, items: [] };
    try {
      return buildCheckInPackedRows(displayAllocationView.unallocated, fromDateTime, toDateTime);
    } catch {
      return { laneCount: 0, items: [] };
    }
  }, [displayAllocationView, fromDateTime, toDateTime]);

  const poolBodyHeight = poolCollapsed ? 0 : Math.max(0, poolHeight - POOL_HEADER_HEIGHT - 8);
  const packedPoolHeight = Math.max(POOL_LANE_HEIGHT, packedUnallocated.laneCount * POOL_LANE_HEIGHT);

  const recordById = useMemo(() => new Map(flightRecords.map((record) => [record.id, record])), [flightRecords]);

  const effectiveRecordById = useMemo(() => {
    const records = new Map<string, FlightRecord>();
    for (const record of flightRecords) {
      const effective = buildEffectiveRecord(record, modifications.get(record.id));
      if (effective) records.set(record.id, effective);
    }
    return records;
  }, [flightRecords, modifications]);

  const resourceBarsByRow = useMemo(() => {
    const rows = new Map<number, CheckInResourceBar[]>();
    for (const bar of displayAllocationView?.resourceBars ?? []) {
      const bars = rows.get(bar.counterIndex) ?? [];
      bars.push(bar);
      rows.set(bar.counterIndex, bars);
    }
    return rows;
  }, [displayAllocationView]);

  const rowLaneCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const bar of displayAllocationView?.resourceBars ?? []) {
      counts.set(bar.counterIndex, Math.max(counts.get(bar.counterIndex) ?? 1, bar.stackLaneCount));
    }
    return counts;
  }, [displayAllocationView]);

  const groupedBarMetadataByRecordId = useMemo(() => {
    const metadata = new Map<string, CheckInGroupedBarMetadata>();
    for (const bar of displayAllocationView?.resourceBars ?? []) {
      const existing = metadata.get(bar.recordId);
      metadata.set(bar.recordId, existing
        ? {
            groupedSpan: existing.groupedSpan + 1,
            groupStartIndex: Math.min(existing.groupStartIndex, bar.counterIndex),
          }
        : {
            groupedSpan: 1,
            groupStartIndex: bar.counterIndex,
          });
    }
    return metadata;
  }, [displayAllocationView]);

  const highlightedGroupId = hoveredGroupId ?? selectedGroupId ?? draggedGroupId;

  const getEffectiveRecord = useCallback((recordId: string): FlightRecord | null => {
    const baseRecord = recordById.get(recordId);
    const latestMod = latestCheckInModificationsRef.current.get(recordId);
    if (!baseRecord && latestMod?.action === 'added' && latestMod.addedLeg) return latestMod.addedLeg as FlightRecord;
    if (!baseRecord) return effectiveRecordById.get(recordId) ?? null;
    return buildEffectiveRecord(baseRecord, latestMod) ?? null;
  }, [effectiveRecordById, recordById]);

  const buildCheckInUndoEntry = useCallback((mods: FlightModification[], description: string): CheckInUndoEntry | null => {
    const inverseMods: FlightModification[] = [];
    const seenRecordIds = new Set<string>();
    for (const mod of mods) {
      if (seenRecordIds.has(mod.legId)) continue;
      seenRecordIds.add(mod.legId);
      const record = getEffectiveRecord(mod.legId);
      if (record) inverseMods.push(buildCheckInUndoModification(record));
    }
    if (inverseMods.length === 0) return null;
    return {
      id: ++checkInUndoSeqRef.current,
      description,
      mods: inverseMods,
    };
  }, [getEffectiveRecord]);

  const pushCheckInUndoEntry = useCallback((entry: CheckInUndoEntry | null) => {
    if (!entry) return;
    checkInUndoStackRef.current.push(entry);
    checkInUndoStackRef.current = trimUiUndoStack(checkInUndoStackRef.current);
  }, []);

  const applyOptimisticCheckInModifications = useCallback((mods: FlightModification[]) => {
    const workingModifications = latestCheckInModificationsRef.current;
    for (const mod of mods) {
      const previous = workingModifications.get(mod.legId);
      workingModifications.set(mod.legId, {
        ...(previous ?? {}),
        ...mod,
        legId: mod.legId,
        action: mod.action,
      });
    }

    const baseView = optimisticAllocationViewRef.current ?? allocationResult.view;
    if (baseView && settings) {
      const changedRecordIds = Array.from(new Set(mods.map((mod) => mod.legId)));
      const projections = changedRecordIds.map((recordId) => {
        const latestMod = workingModifications.get(recordId);
        const baseRecord = recordById.get(recordId) ?? (latestMod?.action === 'added' ? latestMod.addedLeg as FlightRecord | undefined : undefined);
        const effectiveRecord = baseRecord ? buildEffectiveRecord(baseRecord, latestMod) : null;
        return buildCheckInRecordProjection({
          recordId,
          record: effectiveRecord,
          settings,
          from: fromDateTime,
          to: toDateTime,
          roster: baseView.roster,
          resourceRows: baseView.resourceRows,
          pixelsPerMinute: timelinePixelsPerMinute,
        });
      });
      const patchedView = mergeCheckInAllocationViewPatch(baseView, projections);
      optimisticAllocationViewRef.current = patchedView;
      setOptimisticAllocationView(patchedView);
    }
  }, [allocationResult.view, fromDateTime, recordById, settings, timelinePixelsPerMinute, toDateTime]);

  const mergeCheckInUndoEntries = useCallback((
    current: CheckInUndoEntry | null,
    incoming: CheckInUndoEntry | null
  ): CheckInUndoEntry | null => {
    if (!current) return incoming;
    if (!incoming) return current;
    const undoModsByLegId = new Map<string, FlightModification>();
    for (const mod of current.mods) undoModsByLegId.set(mod.legId, mod);
    for (const mod of incoming.mods) {
      if (!undoModsByLegId.has(mod.legId)) undoModsByLegId.set(mod.legId, mod);
    }
    return {
      id: current.id,
      description: current.description === incoming.description ? current.description : 'Batch check-in allocation updates',
      mods: Array.from(undoModsByLegId.values()),
    };
  }, []);

  const mergePendingCheckInCommit = useCallback((
    current: PendingAccumulatedCheckInCommit | null,
    incoming: PendingAccumulatedCheckInCommit
  ): PendingAccumulatedCheckInCommit => {
    if (!current) return incoming;
    const modsByLegId = new Map<string, FlightModification>();
    const legIds = new Set<string>();
    for (const legId of current.legIds) legIds.add(legId);
    for (const mod of current.mods) modsByLegId.set(mod.legId, mod);
    for (const legId of incoming.legIds) legIds.add(legId);
    for (const mod of incoming.mods) modsByLegId.set(mod.legId, mod);
    return {
      legIds: Array.from(legIds),
      mods: Array.from(modsByLegId.values()),
      description: current.description === incoming.description ? current.description : 'Batch check-in allocation updates',
      undoEntry: mergeCheckInUndoEntries(current.undoEntry, incoming.undoEntry),
      trackUndo: current.trackUndo || incoming.trackUndo,
    };
  }, [mergeCheckInUndoEntries]);

  const scheduleSyncSummaryUpdate = useCallback((
    syncMeta: Pick<LocalSyncMeta, 'pendingCount' | 'lastLocalChangeAt'>
  ) => {
    pendingCheckInSyncSummaryRef.current = {
      pendingCount: syncMeta.pendingCount,
      lastLocalChangeAt: syncMeta.lastLocalChangeAt,
    };
    if (checkInSyncSummaryTimerRef.current != null) return;
    checkInSyncSummaryTimerRef.current = window.setTimeout(() => {
      checkInSyncSummaryTimerRef.current = null;
      const pendingSummary = pendingCheckInSyncSummaryRef.current;
      pendingCheckInSyncSummaryRef.current = null;
      if (!pendingSummary) return;
      setSyncSummary((current) => (
        current.pendingCount === pendingSummary.pendingCount &&
        current.lastLocalChangeAt === pendingSummary.lastLocalChangeAt
          ? current
          : {
              ...current,
              pendingCount: pendingSummary.pendingCount,
              lastLocalChangeAt: pendingSummary.lastLocalChangeAt,
            }
      ));
    }, CHECKIN_SYNC_SUMMARY_DEBOUNCE_MS);
  }, []);

  const scheduleCheckInAuditEntry = useCallback((
    entry: PendingAccumulatedCheckInCommit,
    result: CheckInCommitPersistenceResult
  ) => {
    const syncMeta = result.syncMeta;
    const source = result.source ?? 'checkin-worker';
    if (!season || !syncMeta) return;
    const runAudit = () => {
      const auditRecords = entry.legIds.map((legId) => recordById.get(legId)).filter((record): record is FlightRecord => Boolean(record));
      const auditEntry = createFlightActionAuditFromHistory({
        season,
        module: 'checkin',
        operation: entry.description,
        beforeRecords: auditRecords,
        afterRecords: auditRecords,
        afterModifications: entry.mods,
        targetRecordIds: entry.legIds,
        metadata: { source, localRevision: syncMeta.localRevision },
      });
      void appendAuditLogEntry(auditEntry);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(runAudit, { timeout: 1000 });
      return;
    }
    window.setTimeout(runAudit, 0);
  }, [recordById, season]);

  const rollbackAccumulatedCheckInCommit = useCallback(async (
    entry: PendingAccumulatedCheckInCommit,
    error: unknown
  ) => {
    if (entry.undoEntry) {
      applyOptimisticCheckInModifications(entry.undoEntry.mods);
    } else if (season) {
      clearOptimisticAllocationView();
      const result = await queryNativeAllocationWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'checkin',
        limit: 10000,
      });
      if (result) {
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setFlightRecords(result.records);
        replaceCheckInModifications(nextModifications);
        setSyncSummary({
          pendingCount: result.syncMeta.pendingCount,
          lastLocalChangeAt: result.syncMeta.lastLocalChangeAt,
        });
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: season.id,
          season,
          records: result.records,
          modifications: nextModifications,
          syncMeta: result.syncMeta,
          windowKey: buildCheckInWindowKey(fromDateTime, toDateTime),
        });
      }
    }
    void showAlert({
      title: 'Check-in Update Failed',
      message: error instanceof Error ? error.message : String(error),
      tone: 'error',
    });
  }, [applyOptimisticCheckInModifications, clearOptimisticAllocationView, fromDateTime, replaceCheckInModifications, season, showAlert, toDateTime]);

  const flushAccumulatedCheckInCommit = useCallback(async (entry: PendingAccumulatedCheckInCommit) => {
    if (!season) return;
    try {
      const result = await persistCheckInModifications(season.id, entry.mods, entry.description);
      if (!result.syncMeta) return;
      scheduleSyncSummaryUpdate(result.syncMeta);
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        affectedIds: result.affectedIds ?? entry.legIds,
        modifications: entry.mods,
        syncMeta: result.syncMeta,
      });
      publishWorkspaceChange(
        season.id,
        result.syncMeta.localRevision,
        result.source ?? 'checkin-worker',
        result.affectedIds ?? entry.legIds,
        result.syncMeta
      );
      if (entry.trackUndo) pushCheckInUndoEntry(entry.undoEntry);
      scheduleCheckInAuditEntry(entry, result);
    } catch (error) {
      await rollbackAccumulatedCheckInCommit(entry, error);
    }
  }, [persistCheckInModifications, publishWorkspaceChange, pushCheckInUndoEntry, rollbackAccumulatedCheckInCommit, scheduleCheckInAuditEntry, scheduleSyncSummaryUpdate, season]);

  const scheduleAccumulatedCheckInCommit = useCallback(({
    legIds,
    mods,
    description,
    undoEntry,
    trackUndo,
  }: {
    legIds: string[];
    mods: FlightModification[];
    description: string;
    undoEntry: CheckInUndoEntry | null;
    trackUndo: boolean;
  }): void => {
    if (!season) return;
    const entry = mergePendingCheckInCommit(checkInCommitAccumulatorRef.current, {
      legIds: Array.from(new Set(legIds)),
      mods,
      description,
      undoEntry,
      trackUndo,
    });
    checkInCommitAccumulatorRef.current = entry;
    if (checkInCommitFlushTimerRef.current != null) {
      window.clearTimeout(checkInCommitFlushTimerRef.current);
    }
    checkInCommitFlushTimerRef.current = window.setTimeout(() => {
      checkInCommitFlushTimerRef.current = null;
      const entry = checkInCommitAccumulatorRef.current;
      checkInCommitAccumulatorRef.current = null;
      if (entry) {
        void flushAccumulatedCheckInCommit(entry);
      }
    }, CHECKIN_COMMIT_DEBOUNCE_MS);
  }, [flushAccumulatedCheckInCommit, mergePendingCheckInCommit, season]);

  const commitOneModification = useCallback(async (
    mod: FlightModification,
    description: string,
    options: CheckInCommitOptions = {}
  ) => {
    if (!season) return;
    const legIds = [mod.legId];
    const undoEntry = buildCheckInUndoEntry([mod], description);
    applyOptimisticCheckInModifications([mod]);
    scheduleAccumulatedCheckInCommit({
      legIds,
      mods: [mod],
      description,
      undoEntry,
      trackUndo: options.trackUndo !== false,
    });
  }, [applyOptimisticCheckInModifications, buildCheckInUndoEntry, scheduleAccumulatedCheckInCommit, season]);

  const commitCheckInModificationBatch = useCallback(async (
    mods: FlightModification[],
    description: string,
    options: CheckInCommitOptions = {}
  ) => {
    if (!season || mods.length === 0) return;
    const legIds = Array.from(new Set(mods.map((mod) => mod.legId)));
    const undoEntry = buildCheckInUndoEntry(mods, description);
    applyOptimisticCheckInModifications(mods);
    scheduleAccumulatedCheckInCommit({
      legIds,
      mods,
      description,
      undoEntry,
      trackUndo: options.trackUndo !== false,
    });
  }, [applyOptimisticCheckInModifications, buildCheckInUndoEntry, scheduleAccumulatedCheckInCommit, season]);

  const handleUndoCheckInAllocation = useCallback(async () => {
    if (syncing) return;
    const entry = checkInUndoStackRef.current.pop();
    if (!entry) return;
    try {
      await commitCheckInModificationBatch(entry.mods, `Undo ${entry.description}`, { trackUndo: false });
    } catch (err) {
      checkInUndoStackRef.current.push(entry);
      void showAlert({ title: 'Undo Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitCheckInModificationBatch, showAlert, syncing]);

  const setActiveDropRowIndexIfChanged = useCallback((rowIndex: number | null) => {
    setActiveDropRowIndex((current) => current === rowIndex ? current : rowIndex);
  }, []);

  const setActiveDropSpanIfChanged = useCallback((dropSpan: number) => {
    setActiveDropSpan((current) => current === dropSpan ? current : dropSpan);
  }, []);

  const setPoolDropActiveIfChanged = useCallback((active: boolean) => {
    setPoolDropActive((current) => current === active ? current : active);
  }, []);

  const setSnapLineXIfChanged = useCallback((left: number | null) => {
    setSnapLineX((current) => current === left ? current : left);
  }, []);

  const setSnapLineLabelIfChanged = useCallback((label: string | null) => {
    setSnapLineLabel((current) => current === label ? current : label);
  }, []);

  const applyEdgeScroll = useCallback((clientX: number, clientY: number) => {
    const container = ganttScrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const velocity = calculateCheckInEdgeScroll({
      pointerX: clientX,
      pointerY: clientY,
      rect,
      threshold: EDGE_SCROLL_THRESHOLD,
      maxSpeed: EDGE_SCROLL_MAX_SPEED,
    });
    if (velocity.x !== 0) container.scrollLeft += velocity.x;
    if (velocity.y !== 0) container.scrollTop += velocity.y;
  }, []);

  const applyVerticalEdgeScroll = useCallback((clientX: number, clientY: number) => {
    const container = ganttScrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const velocity = calculateCheckInEdgeScroll({
      pointerX: clientX,
      pointerY: clientY,
      rect,
      threshold: EDGE_SCROLL_THRESHOLD,
      maxSpeed: EDGE_SCROLL_MAX_SPEED,
    });
    if (velocity.y !== 0) container.scrollTop += velocity.y;
  }, []);

  const updateSnapLine = useCallback((state: ResizeState, clientX: number) => {
    const preview = buildCheckInResizePreview({
      edge: state.edge,
      anchorX: state.anchorX,
      anchorTime: state.anchorTime,
      startClientX: state.startClientX,
      clientX,
      pixelsPerMinute: timelinePixelsPerMinute,
      timelineWidth: timeline.width,
    });
    setSnapLineXIfChanged(preview.markerX);
    setSnapLineLabelIfChanged(preview.label);
  }, [setSnapLineLabelIfChanged, setSnapLineXIfChanged, timeline.width, timelinePixelsPerMinute]);

  const scheduleSnapLineUpdate = useCallback((state: ResizeState, clientX: number) => {
    pendingSnapLineClientXRef.current = clientX;
    if (snapLineAnimationFrameRef.current != null) return;
    snapLineAnimationFrameRef.current = window.requestAnimationFrame(() => {
      snapLineAnimationFrameRef.current = null;
      const nextClientX = pendingSnapLineClientXRef.current;
      pendingSnapLineClientXRef.current = null;
      if (nextClientX != null) updateSnapLine(state, nextClientX);
    });
  }, [updateSnapLine]);

  const clearSnapLine = useCallback(() => {
    if (snapLineAnimationFrameRef.current != null) {
      window.cancelAnimationFrame(snapLineAnimationFrameRef.current);
      snapLineAnimationFrameRef.current = null;
    }
    pendingSnapLineClientXRef.current = null;
    setSnapLineXIfChanged(null);
    setSnapLineLabelIfChanged(null);
  }, [setSnapLineLabelIfChanged, setSnapLineXIfChanged]);

  const scheduleDropPreviewUpdate = useCallback((previewStartRow: number | null) => {
    pendingDropPreviewRowRef.current = previewStartRow;
    if (dropPreviewAnimationFrameRef.current != null) return;
    dropPreviewAnimationFrameRef.current = window.requestAnimationFrame(() => {
      dropPreviewAnimationFrameRef.current = null;
      const nextPreviewStartRow = pendingDropPreviewRowRef.current;
      pendingDropPreviewRowRef.current = null;
      setActiveDropRowIndexIfChanged(nextPreviewStartRow);
    });
  }, [setActiveDropRowIndexIfChanged]);

  const clearDropPreview = useCallback(() => {
    if (dropPreviewAnimationFrameRef.current != null) {
      window.cancelAnimationFrame(dropPreviewAnimationFrameRef.current);
      dropPreviewAnimationFrameRef.current = null;
    }
    pendingDropPreviewRowRef.current = null;
    setActiveDropRowIndexIfChanged(null);
    setActiveDropSpanIfChanged(1);
  }, [setActiveDropRowIndexIfChanged, setActiveDropSpanIfChanged]);

  const startResizeInteraction = useCallback((edge: ResizeState['edge'], bar: CheckInResourceBar, clientX: number) => {
    if (syncing) return;
    resizeDragGuardRef.current = true;
    const left = (bar.leftPercent / 100) * timeline.width;
    const width = (bar.widthPercent / 100) * timeline.width;
    const nextResizeState = {
      edge,
      bar,
      startClientX: clientX,
      anchorX: edge === 'start' ? left : left + width,
      anchorTime: edge === 'start' ? bar.start : bar.end,
    };
    setResizeState(nextResizeState);
    updateSnapLine(nextResizeState, clientX);
  }, [syncing, timeline.width, updateSnapLine]);

  useEffect(() => {
    const commitRequests = checkInCommitRequestsRef.current;
    return () => {
      if (snapLineAnimationFrameRef.current != null) window.cancelAnimationFrame(snapLineAnimationFrameRef.current);
      if (dropPreviewAnimationFrameRef.current != null) window.cancelAnimationFrame(dropPreviewAnimationFrameRef.current);
      clearCheckInCommitAccumulator();
      checkInCommitWorkerRef.current?.terminate();
      checkInCommitWorkerRef.current = null;
      const error = new Error('Check-in local commit worker was closed.');
      for (const pending of commitRequests.values()) pending.reject(error);
      commitRequests.clear();
    };
  }, [clearCheckInCommitAccumulator]);

  const handleToday = () => {
    promoteLatestCheckInModificationsForView();
    const next = buildDefaultDailyDateRange(todayIso());
    setFromDateTime(next.from);
    setToDateTime(next.to);
  };

  const handleQuickRange = (days: number) => {
    promoteLatestCheckInModificationsForView();
    setToDateTime(addDaysToLocalDateTime(fromDateTime, days));
  };

  const handleSync = useCallback(async () => {
    if (!season || syncing) return;
    setResizeState(null);
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Save Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [season, showAlert, syncing, syncNow]);

  const handleFetchUpdates = useCallback(async () => {
    if (!syncSeasonId || fetchingUpdates || syncing) return;
    setResizeState(null);
    try {
      const result = await fetchUpdatesNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Fetch Updates Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Fetch Updates Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [fetchUpdatesNow, fetchingUpdates, showAlert, syncSeasonId, syncing]);

  const handleOpenExportDialog = useCallback(() => {
    promoteLatestCheckInModificationsForView();
    const range = { from: fromDateTime, to: toDateTime };
    let selectedGroupIds: string[] = [];
    if (settings) {
      try {
        selectedGroupIds = buildCheckInPdfPreviewPlan({
          records: flightRecords,
          modifications: latestCheckInModificationsRef.current,
          settings,
          range,
        }).availableGroups.map((group) => group.id);
      } catch {
        selectedGroupIds = [];
      }
    }
    setExportDraft({ ...range, selectedGroupIds });
  }, [flightRecords, fromDateTime, promoteLatestCheckInModificationsForView, settings, toDateTime]);

  const handleExportCheckInPdf = useCallback(async () => {
    if (!season || !settings || !exportDraft) return;
    if (!isValidCheckInExportRange(exportDraft)) {
      void showAlert({
        title: 'Export PDF Failed',
        message: 'Choose a valid export range where To is later than From.',
        tone: 'error',
      });
      return;
    }
    if (exportDraft.selectedGroupIds.length === 0) {
      void showAlert({
        title: 'Export PDF Failed',
        message: 'Select at least one Counter Group before exporting.',
        tone: 'error',
      });
      return;
    }
    setExportingPdf(true);
    try {
      const result = await exportCheckInAllocationPdf({
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
        settings,
        range: exportDraft,
        selectedGroupIds: exportDraft.selectedGroupIds,
        seasonCode: season.seasonCode,
        fileName: buildCheckInPdfFileName(season.seasonCode, exportDraft),
      });
      notifyExportCompleted(result.saveResult);
      setExportDraft(null);
    } catch (err) {
      void showAlert({ title: 'Export PDF Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setExportingPdf(false);
    }
  }, [exportDraft, flightRecords, notifyExportCompleted, season, settings, showAlert]);

  const handleAllocate = useCallback(async (recordId: string, startCounter: CheckInCounter) => {
    const view = displayAllocationView;
    if (!settings || !view) return;
    const record = getEffectiveRecord(recordId);
    if (!record) return;
    try {
      const mod = allocateCheckInCounters({
        record,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
        settings,
        roster: view.roster,
        resources: view.resourceRows,
        startCounter,
      });
      await commitOneModification(mod, `Allocated ${formatCheckInFlightLabel(record)} to counter ${displayCheckInCounter(startCounter)}`);
    } catch (err) {
      void showAlert({ title: 'Allocate Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert]);

  const handleMove = useCallback(async (
    drag: Extract<DragState, { kind: 'allocated' }>,
    targetRowIndex: number
  ) => {
    const view = displayAllocationView;
    if (!view || !settings) return;
    const record = getEffectiveRecord(drag.recordId);
    if (!record) return;
    const rowDelta = targetRowIndex - drag.counterIndex;
    try {
      const mod = moveCheckInAllocation({
        record,
        roster: view.roster,
        resources: view.resourceRows,
        settings,
        counter: drag.mode === 'broken' ? drag.counter : undefined,
        rowDelta,
        minuteDelta: 0,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
      });
      await commitOneModification(mod, `Moved ${formatCheckInFlightLabel(record)} check-in allocation`);
    } catch (err) {
      void showAlert({ title: 'Move Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert]);

  const handleResizeCommit = useCallback(async (state: ResizeState, endClientX: number) => {
    const view = displayAllocationView;
    if (syncing || !view || !settings) return;
    const record = getEffectiveRecord(state.bar.recordId);
    if (!record) return;
    try {
      const preview = buildCheckInResizePreview({
        edge: state.edge,
        anchorX: state.anchorX,
        anchorTime: state.anchorTime,
        startClientX: state.startClientX,
        clientX: endClientX,
        pixelsPerMinute: timelinePixelsPerMinute,
        timelineWidth: timeline.width,
      });
      const mod = resizeCheckInAllocation({
        record,
        counter: state.bar.counter,
        edge: state.edge,
        minuteDelta: preview.minuteDelta,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
        resources: view.resourceRows,
        settings,
      });
      await commitOneModification(mod, `Resized ${formatCheckInFlightLabel(record)} check-in allocation`);
    } catch (err) {
      void showAlert({ title: 'Resize Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert, syncing, timeline.width, timelinePixelsPerMinute]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    if (!resizeState) return undefined;
    document.body.style.cursor = 'ew-resize';
    const handlePointerMove = (event: PointerEvent) => {
      scheduleSnapLineUpdate(resizeState, event.clientX);
      applyEdgeScroll(event.clientX, event.clientY);
    };
    const handlePointerUp = (event: PointerEvent) => {
      const nextState = resizeState;
      resizeDragGuardRef.current = false;
      setResizeState(null);
      clearSnapLine();
      void handleResizeCommit(nextState, event.clientX);
    };
    const handleCancel = () => {
      resizeDragGuardRef.current = false;
      setResizeState(null);
      clearSnapLine();
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    window.addEventListener('pointercancel', handleCancel, { once: true });
    return () => {
      document.body.style.cursor = '';
      if (!resizeState) resizeDragGuardRef.current = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [applyEdgeScroll, clearSnapLine, handleResizeCommit, isRouteActive, resizeState, scheduleSnapLineUpdate, updateSnapLine]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreCheckInUndoShortcut(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void handleUndoCheckInAllocation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndoCheckInAllocation, isRouteActive]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    if (!contextMenu) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu, isRouteActive]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    const handleFullscreenChange = () => {
      setIsGanttFullscreen(document.fullscreenElement === ganttFullscreenRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [isRouteActive]);

  const handleGanttFullscreenToggle = useCallback(async () => {
    const wrapper = ganttFullscreenRef.current;
    if (!wrapper) return;
    try {
      if (document.fullscreenElement === wrapper) {
        await document.exitFullscreen();
      } else {
        await wrapper.requestFullscreen();
      }
    } catch (err) {
      void showAlert({ title: 'Fullscreen Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [showAlert]);

  const handleTimelineZoom = useCallback((direction: -1 | 1) => {
    promoteLatestCheckInModificationsForView();
    setTimelinePixelsPerMinute((current) => clampTimelinePixelsPerMinute(current + direction * TIMELINE_ZOOM_STEP));
  }, [promoteLatestCheckInModificationsForView, setTimelinePixelsPerMinute]);

  const canZoomOut = timelinePixelsPerMinute > MIN_TIMELINE_PIXELS_PER_MINUTE;
  const canZoomIn = timelinePixelsPerMinute < MAX_TIMELINE_PIXELS_PER_MINUTE;

  const handleResourceDrop = useCallback((event: DragEvent<HTMLDivElement>, rowIndex: number, counter: CheckInCounter) => {
    event.preventDefault();
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDraggedGroupId(null);
    clearDropPreview();
    if (!drag || syncing) return;
    if (drag.kind === 'unallocated') {
      void handleAllocate(drag.recordId, counter);
      return;
    }
    void handleMove(drag, rowIndex);
  }, [clearDropPreview, handleAllocate, handleMove, syncing]);

  const handleResourceDragOver = useCallback((
    event: DragEvent<HTMLDivElement>,
    rowIndex: number,
    view: CheckInAllocationView
  ) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const drag = dragStateRef.current;
    const dropTarget = resolveDropTargetRow(drag, rowIndex, view);
    scheduleDropPreviewUpdate(dropTarget.previewStartRow);
    if (drag?.kind === 'allocated') {
      applyVerticalEdgeScroll(event.clientX, event.clientY);
    } else {
      applyEdgeScroll(event.clientX, event.clientY);
    }
  }, [applyEdgeScroll, applyVerticalEdgeScroll, scheduleDropPreviewUpdate]);

  const handleResourceRowDrop = useCallback((
    event: DragEvent<HTMLDivElement>,
    rowIndex: number,
    view: CheckInAllocationView
  ) => {
    const dropTarget = resolveDropTargetRow(dragStateRef.current, rowIndex, view);
    handleResourceDrop(event, dropTarget.rowIndex, dropTarget.counter);
  }, [handleResourceDrop]);

  const handlePoolDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDraggedGroupId(null);
    clearDropPreview();
    setPoolDropActiveIfChanged(false);
    if (!drag || drag.kind !== 'allocated' || syncing) return;
    const record = getEffectiveRecord(drag.recordId);
    if (!record) return;
    const currentCounters = normalizeCheckInCounterList(record.counter);
    const shouldRemoveBrokenCounter = drag.mode === 'broken' && currentCounters.length > 1;
    const view = displayAllocationView;
    let mod: FlightModification;
    if (shouldRemoveBrokenCounter) {
      if (!view || !settings) return;
      mod = removeCheckInCounter({
        record,
        clickedCounter: drag.counter,
        resources: view.resourceRows,
        settings,
      });
    } else {
      mod = unallocateCheckInRecord(record);
    }
    const description = shouldRemoveBrokenCounter
      ? `Removed counter ${displayCheckInCounter(drag.counter)} from ${formatCheckInFlightLabel(record)} by pool drop`
      : `Unallocated ${formatCheckInFlightLabel(record)} by pool drop`;
    void commitOneModification(
      mod,
      description
    ).catch((err) => {
      void showAlert({ title: 'Unallocate Failed', message: (err as Error).message, tone: 'error' });
    });
  }, [clearDropPreview, commitOneModification, displayAllocationView, getEffectiveRecord, setPoolDropActiveIfChanged, settings, showAlert, syncing]);

  const handleDragEnd = useCallback(() => {
    dragStateRef.current = null;
    setDraggedGroupId(null);
    clearDropPreview();
    setPoolDropActiveIfChanged(false);
  }, [clearDropPreview, setPoolDropActiveIfChanged]);

  const handleGanttDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    if (dragStateRef.current.kind === 'allocated') {
      applyVerticalEdgeScroll(event.clientX, event.clientY);
    } else {
      applyEdgeScroll(event.clientX, event.clientY);
    }
  }, [applyEdgeScroll, applyVerticalEdgeScroll]);

  const handlePoolDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.kind !== 'allocated' || syncing) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setPoolDropActiveIfChanged(true);
    applyVerticalEdgeScroll(event.clientX, event.clientY);
  }, [applyVerticalEdgeScroll, setPoolDropActiveIfChanged, syncing]);

  const handlePoolDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setPoolDropActiveIfChanged(false);
    }
  }, [setPoolDropActiveIfChanged]);

  const handleUnallocatedDragStart = useCallback((event: DragEvent<HTMLButtonElement>, item: CheckInPackedItem) => {
    const color = getCheckInColorToken(item.record, settings);
    setSolidFlightBarDragImage(event, {
      label: `${formatCheckInFlightLabel(item.record)} (${item.requiredCounters})`,
      backgroundColor: color.backgroundColor,
      textColor: color.textColor,
    });
    dragStateRef.current = { kind: 'unallocated', recordId: item.record.id, dropSpan: item.requiredCounters, startClientX: event.clientX };
    setDraggedGroupId(item.record.id);
    setActiveDropSpanIfChanged(item.requiredCounters);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.record.id);
  }, [setActiveDropSpanIfChanged, settings]);

  const handleResourceBarDragStart = useCallback((
    event: DragEvent<HTMLDivElement>,
    bar: CheckInResourceBar,
    groupStartIndex: number,
    groupedSpan: number
  ) => {
    if (resizeDragGuardRef.current || resizeState) {
      event.preventDefault();
      return;
    }
    const record = recordById.get(bar.recordId);
    const color = getCheckInColorToken(record ?? { airline: bar.flightNumber.slice(0, 2), flightNumber: bar.flightNumber, rawFlightNumber: bar.flightNumber }, settings);
    setSolidFlightBarDragImage(event, {
      label: bar.flightNumber,
      backgroundColor: color.backgroundColor,
      textColor: color.textColor,
    });
    dragStateRef.current = {
      kind: 'allocated',
      recordId: bar.recordId,
      counter: bar.counter,
      counterIndex: bar.counterIndex,
      groupStartIndex,
      dragRowOffset: bar.counterIndex - groupStartIndex,
      dropSpan: bar.mode === 'grouped' ? groupedSpan : 1,
      mode: bar.mode,
      startClientX: event.clientX,
    };
    setDraggedGroupId(bar.groupId);
    setActiveDropSpanIfChanged(bar.mode === 'grouped' ? groupedSpan : 1);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', bar.recordId);
  }, [recordById, resizeState, setActiveDropSpanIfChanged, settings]);

  const handleBreakShape = useCallback(async (bar: CheckInResourceBar) => {
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    try {
      const mod = breakCheckInAllocation({ record, currentCounter: record.counter });
      await commitOneModification(mod, `Broke ${formatCheckInFlightLabel(record)} check-in shape`);
    } catch (err) {
      void showAlert({ title: 'Break Shape Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, getEffectiveRecord, showAlert]);

  const handleReshapeShape = useCallback(async (bar: CheckInResourceBar) => {
    const view = displayAllocationView;
    if (!view || !settings) return;
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    try {
      const mod = reshapeCheckInAllocation({
        record,
        roster: view.roster,
        resources: view.resourceRows,
        settings,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
      });
      await commitOneModification(mod, `Reshaped ${formatCheckInFlightLabel(record)} check-in shape`);
    } catch (err) {
      void showAlert({ title: 'Reshape Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert]);

  const handleAddCounter = useCallback(async (bar: CheckInResourceBar) => {
    const view = displayAllocationView;
    if (!view || !settings) return;
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    try {
      const mod = addCheckInCounter({
        record,
        roster: view.roster,
        resources: view.resourceRows,
        settings,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
      });
      await commitOneModification(mod, `Added counter to ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Add Counter Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert]);

  const handleRemoveCounter = useCallback(async (bar: CheckInResourceBar) => {
    const view = displayAllocationView;
    if (!view || !settings) return;
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    try {
      const mod = removeCheckInCounter({
        record,
        clickedCounter: bar.counter,
        resources: view.resourceRows,
        settings,
      });
      await commitOneModification(mod, `Removed counter from ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Remove Counter Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, getEffectiveRecord, settings, showAlert]);

  const openOverrideTimes = useCallback((bar: CheckInResourceBar) => {
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    setOverrideDraft({
      recordId: record.id,
      flightLabel: `${formatCheckInFlightLabel(record)} / ${displayCheckInCounter(bar.counter)}`,
      counter: bar.counter,
      start: bar.start,
      end: bar.end,
    });
  }, [getEffectiveRecord]);

  const handleOverrideSubmit = useCallback(async () => {
    const view = displayAllocationView;
    if (!overrideDraft || !view || !settings) return;
    const record = getEffectiveRecord(overrideDraft.recordId);
    if (!record) return;
    try {
      const mod = overrideCheckInTimes({
        record,
        counter: overrideDraft.counter,
        start: overrideDraft.start,
        end: overrideDraft.end,
        records: flightRecords,
        modifications: latestCheckInModificationsRef.current,
        resources: view.resourceRows,
        settings,
      });
      await commitOneModification(mod, `Overrode ${formatCheckInFlightLabel(record)} check-in times`);
      setOverrideDraft(null);
    } catch (err) {
      void showAlert({ title: 'Override Times Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, overrideDraft, settings, showAlert]);

  const handleUnallocate = useCallback(async (recordId: string) => {
    const record = getEffectiveRecord(recordId);
    if (!record) return;
    try {
      await commitOneModification(unallocateCheckInRecord(record), `Unallocated ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Unallocate Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitOneModification, getEffectiveRecord, showAlert]);

  const handleUnallocateAllInPeriod = useCallback(async () => {
    const view = displayAllocationView;
    if (!view) return;
    const visibleRecordIds = Array.from(new Set(view.resourceBars.map((bar) => bar.recordId)));
    const visibleRecords = visibleRecordIds
      .map((recordId) => getEffectiveRecord(recordId))
      .filter((record): record is FlightRecord => record != null);
    const mods = buildCheckInPeriodUnallocationModifications({
      records: visibleRecords,
      resourceBars: view.resourceBars,
      resources: view.resourceRows,
      settings: settings ?? undefined,
    });
    if (mods.length === 0) return;
    try {
      await commitCheckInModificationBatch(
        mods,
        `Unallocated all check-in counters from ${formatLocalDateTimeLabel(fromDateTime)} to ${formatLocalDateTimeLabel(toDateTime)}`
      );
    } catch (err) {
      void showAlert({ title: 'Unallocate All Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitCheckInModificationBatch, displayAllocationView, fromDateTime, getEffectiveRecord, settings, showAlert, toDateTime]);

  const handleContextAction = useCallback((action: 'break' | 'reshape' | 'add' | 'remove' | 'override' | 'unallocate') => {
    if (!contextMenu) return;
    const { bar } = contextMenu;
    setContextMenu(null);
    if (action === 'break') void handleBreakShape(bar);
    if (action === 'reshape') void handleReshapeShape(bar);
    if (action === 'add') void handleAddCounter(bar);
    if (action === 'remove') void handleRemoveCounter(bar);
    if (action === 'override') openOverrideTimes(bar);
    if (action === 'unallocate') void handleUnallocate(bar.recordId);
  }, [contextMenu, handleAddCounter, handleBreakShape, handleRemoveCounter, handleReshapeShape, handleUnallocate, openOverrideTimes]);

  const openBarContextMenu = useCallback((bar: CheckInResourceBar, x: number, y: number) => {
    setSelectedGroupId(bar.groupId);
    setContextMenu({ x, y, bar });
  }, []);

  const handleBarKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, bar: CheckInResourceBar) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedGroupId(bar.groupId);
      return;
    }
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openBarContextMenu(bar, rect.left + Math.min(rect.width - 8, 24), rect.bottom + 4);
    }
  }, [openBarContextMenu]);

  const handleResourceBarHoverStart = useCallback((groupId: string) => {
    setHoveredGroupId(groupId);
  }, []);

  const handleResourceBarHoverEnd = useCallback((groupId: string) => {
    setHoveredGroupId((current) => current === groupId ? null : current);
  }, []);

  const handleResourceBarSelect = useCallback((groupId: string) => {
    setSelectedGroupId(groupId);
  }, []);

  const renderUnallocatedBar = (item: CheckInPackedItem) => {
    const label = `${formatCheckInFlightLabel(item.record)} (${item.requiredCounters})`;
    const color = getCheckInColorToken(item.record, settings);
    const left = (item.leftPercent / 100) * timeline.width;
    const rawWidth = (item.widthPercent / 100) * timeline.width;
    const width = Math.max(MIN_BAR_WIDTH, rawWidth);
    const fullLabel = rawWidth >= FULL_BAR_LABEL_WIDTH;
    return (
      <button
        key={item.record.id}
        type="button"
        draggable={!syncing}
        aria-label={`${label}, ${formatLocalDateTimeLabel(item.window.start)} to ${formatLocalDateTimeLabel(item.window.end)}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onDragStart={(event) => handleUnallocatedDragStart(event, item)}
        onDragEnd={handleDragEnd}
        className="absolute flex h-6 cursor-grab items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold transition-[transform,width,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing"
        style={{
          left: 0,
          top: 0,
          transform: `translate3d(${left}px, ${item.laneIndex * POOL_LANE_HEIGHT + 4}px, 0)`,
          width,
          background: color.backgroundColor,
          backgroundColor: color.backgroundColor,
          backgroundImage: 'none',
          border: '1px solid #FFFFFF',
          borderRadius: 4,
          boxShadow: 'none',
          color: color.textColor,
          opacity: 1,
        }}
        title={`${label} | ${item.ruleName} | ${formatLocalDateTimeLabel(item.window.start)} - ${formatLocalDateTimeLabel(item.window.end)}`}
      >
        <span className="truncate">{label}</span>
        {fullLabel && (
          <span className="ml-auto shrink-0 pl-2 font-data-tabular font-semibold">
            {formatCheckInDisplayTime(item.window.start)}-{formatCheckInDisplayTime(item.window.end)}
          </span>
        )}
      </button>
    );
  };

  const renderResourceBar = useCallback((bar: CheckInResourceBar) => {
    const highlighted = highlightedGroupId === bar.groupId;
    const left = (bar.leftPercent / 100) * timeline.width;
    const width = Math.max(MIN_BAR_WIDTH, (bar.widthPercent / 100) * timeline.width);
    const record = recordById.get(bar.recordId);
    const color = getCheckInColorToken(record ?? { airline: bar.flightNumber.slice(0, 2), flightNumber: bar.flightNumber, rawFlightNumber: bar.flightNumber }, settings);
    const groupedMetadata = groupedBarMetadataByRecordId.get(bar.recordId);
    const groupedSpan = bar.mode === 'grouped' ? groupedMetadata?.groupedSpan ?? 1 : 1;
    const groupStartIndex = bar.mode === 'grouped' ? groupedMetadata?.groupStartIndex ?? bar.counterIndex : bar.counterIndex;
    return (
      <CheckInResourceBarButton
        key={bar.id}
        bar={bar}
        color={color}
        highlighted={highlighted}
        left={left}
        width={width}
        groupedSpan={groupedSpan}
        groupStartIndex={groupStartIndex}
        syncing={syncing}
        resizing={resizeState !== null}
        onDragStart={handleResourceBarDragStart}
        onDragEnd={handleDragEnd}
        onHoverStart={handleResourceBarHoverStart}
        onHoverEnd={handleResourceBarHoverEnd}
        onSelect={handleResourceBarSelect}
        onOpenContextMenu={openBarContextMenu}
        onKeyDown={handleBarKeyDown}
        onResizeStart={startResizeInteraction}
      />
    );
  }, [
    groupedBarMetadataByRecordId,
    handleBarKeyDown,
    handleDragEnd,
    handleResourceBarDragStart,
    handleResourceBarHoverEnd,
    handleResourceBarHoverStart,
    handleResourceBarSelect,
    highlightedGroupId,
    openBarContextMenu,
    recordById,
    resizeState,
    settings,
    startResizeInteraction,
    syncing,
    timeline.width,
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface font-sans" onClick={() => setContextMenu(null)}>
      <div className="flex h-screen min-w-0 flex-1 flex-col bg-surface">
        <header className="z-30 flex flex-none items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Check-in Allocation</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">{season ? buildSeasonDisplayLabel(season) : 'No season selected'}</p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={season?.id ?? ''}
              onChange={(event) => router.push(`/checkin?season=${event.target.value}`)}
              disabled={seasons.length === 0 || syncing}
              className="min-w-[200px] cursor-pointer rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm font-medium text-on-surface shadow-sm transition-colors hover:bg-surface-container-high focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {seasons.length === 0 ? (
                <option value="">No seasons</option>
              ) : seasons.map((item) => (
                <option key={item.id} value={item.id}>{buildSeasonDisplayLabel(item)}</option> 
              ))}
            </select>
            {season && (
              <>
                <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${
                  syncTone === 'error'
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : syncTone === 'info'
                      ? 'border-sky-200 bg-sky-50 text-sky-800'
                      : syncTone === 'warning'
                        ? 'border-amber-200 bg-amber-50 text-amber-800'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                }`}>
                  {syncLabel}
                </span>
                <SeasonConflictReviewControl seasonId={season?.id} />
                <FetchServerUpdatesButton
                  fetching={fetchingUpdates}
                  progress={fetchProgress}
                  disabled={syncing}
                  onFetch={handleFetchUpdates}
                />
                <SyncActionButton
                  syncing={syncing}
                  pendingCount={syncPendingCount}
                  progress={syncProgress}
                  onSync={handleSync}
                />
              </>
            )}
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <section className="flex-none rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-variant px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  From
                  <input
                    type="datetime-local"
                    value={fromDateTime}
                    onChange={(event) => {
                      promoteLatestCheckInModificationsForView();
                      setFromDateTime(event.target.value);
                    }}
                    className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  To
                  <input
                    type="datetime-local"
                    value={toDateTime}
                    onChange={(event) => {
                      promoteLatestCheckInModificationsForView();
                      setToDateTime(event.target.value);
                    }}
                    className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <button
                  onClick={handleToday}
                  className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
                >
                  <span className="material-symbols-outlined text-[16px]">today</span>
                  Today
                </button>
                {[1, 2, 3].map((days) => (
                  <button
                    key={days}
                    onClick={() => handleQuickRange(days)}
                    className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high"
                  >
                    {days}D
                  </button>
                ))}
                <label className="inline-flex cursor-pointer items-center gap-2 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high">
                  <input
                    type="checkbox"
                    checked={groupByCounterGroup}
                    onChange={(event) => {
                      promoteLatestCheckInModificationsForView();
                      setGroupByCounterGroup(event.target.checked);
                    }}
                    className="sr-only"
                  />
                  <span className="material-symbols-outlined text-[18px] text-primary">
                    {groupByCounterGroup ? 'toggle_on' : 'toggle_off'}
                  </span>
                  Group by island
                </label>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-container px-3 py-1 text-xs font-bold text-on-primary-container">UNALLOC {summary.unallocated}</span>
                <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">ALLOC {summary.allocatedFlights}</span>
                <span className="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container">BLOCKS {summary.counterBlocks}</span>
              </div>
            </div>
            {(allocationResult.error || timeline.error) && (
              <div className="border-t border-error/20 bg-error-container/30 px-4 py-2 text-sm text-error">
                {allocationResult.error ?? timeline.error}
              </div>
            )}
          </section>

          <section
            ref={ganttFullscreenRef}
            className={`relative min-h-0 flex-1 overflow-hidden rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm ${isGanttFullscreen ? 'fixed inset-0 z-[100] h-screen w-screen rounded-none border-0 bg-surface shadow-none' : ''}`}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 flex-none items-center justify-between border-b border-surface-variant bg-surface-container-low px-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-on-surface">
                  <span className="material-symbols-outlined text-[18px]">view_timeline</span>
                  Check-in Gantt
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUnallocateAllInPeriod();
                    }}
                    disabled={syncing || summary.counterBlocks === 0}
                    className="flex h-7 items-center gap-1.5 rounded border border-outline-variant bg-surface-container-lowest px-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Unallocate all counters in selected period"
                    title="Unallocate all counters in selected period"
                  >
                    <span className="material-symbols-outlined text-[18px]">playlist_remove</span>
                    Unallocate All
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenExportDialog();
                    }}
                    disabled={!season || !settings || loading || exportingPdf}
                    className="flex h-7 items-center gap-1.5 rounded border border-outline-variant bg-surface-container-lowest px-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Export PDF"
                    title="Export PDF"
                  >
                    <span className={`material-symbols-outlined text-[18px] ${exportingPdf ? 'animate-spin' : ''}`}>{exportingPdf ? 'sync' : 'picture_as_pdf'}</span>
                    Export PDF
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTimelineZoom(-1);
                    }}
                    disabled={!canZoomOut}
                    className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Zoom out timeline"
                    title="Zoom out"
                  >
                    <span className="material-symbols-outlined text-[18px]">remove</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTimelineZoom(1);
                    }}
                    disabled={!canZoomIn}
                    className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Zoom in timeline"
                    title="Zoom in"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleGanttFullscreenToggle();
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface transition-colors hover:bg-surface-container-high"
                    aria-label={isGanttFullscreen ? 'Exit Gantt fullscreen' : 'Enter Gantt fullscreen'}
                    title={isGanttFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  >
                    <span className="material-symbols-outlined text-[18px]">{isGanttFullscreen ? 'fullscreen_exit' : 'fullscreen'}</span>
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
            {loading ? (
              <LoadingStatusPanel progress={loadProgress} className="h-full min-h-[320px]" />
            ) : loadError ? (
              <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="text-sm font-semibold text-error">Cannot load check-in data</div>
                <div className="max-w-xl text-sm text-on-surface-variant">{loadError}</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingUpdates}
                    progress={fetchProgress}
                    disabled={syncing}
                    onFetch={handleFetchUpdates}
                  />
                )}
              </div>
            ) : !season ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-on-surface-variant">
                <div>No season data.</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingUpdates}
                    progress={fetchProgress}
                    disabled={syncing}
                    onFetch={handleFetchUpdates}
                  />
                )}
              </div>
            ) : !displayAllocationView || !timeline.ticks ? (
              <div className="flex h-full items-center justify-center text-sm text-error">
                {allocationResult.error ?? timeline.error ?? 'Check-in allocation view is unavailable.'}
              </div>
            ) : (
              <div
                ref={ganttScrollRef}
                className="h-full overflow-auto"
                onDragOver={handleGanttDragOver}
                onClick={() => {
                  setSelectedGroupId(null);
                  setContextMenu(null);
                }}
              >
                <div className="relative" style={{ minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                  <TimelineHeader
                    ticks={timeline.ticks}
                    timelineWidth={timeline.width}
                    snapLineX={snapLineX}
                    snapLineLabel={snapLineLabel}
                  />
                  {snapLineX != null && (
                    <div
                      className="pointer-events-none absolute bottom-0 top-0 z-50 border-l-2 border-primary/80"
                      style={{ left: LABEL_COLUMN_WIDTH + snapLineX }}
                    />
                  )}

                  <div
                    className={`sticky top-14 z-30 border-b border-surface-variant bg-surface-container-lowest shadow-sm transition-colors duration-150 ${poolDropActive ? 'ring-2 ring-primary/50 bg-primary-container/20' : ''}`}
                    style={{ height: poolCollapsed ? POOL_HEADER_HEIGHT : poolHeight }}
                    onDragOver={handlePoolDragOver}
                    onDragLeave={handlePoolDragLeave}
                    onDrop={handlePoolDrop}
                  >
                    <div className="flex h-9 items-center border-b border-surface-variant bg-surface-container-low">
                      <div
                        className="sticky left-0 z-30 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-low px-3 text-xs font-semibold text-on-surface"
                        style={{ width: LABEL_COLUMN_WIDTH }}
                      >
                        <span className="material-symbols-outlined text-[17px]">inventory_2</span>
                        Unallocated
                      </div>
                      <div className="flex h-full shrink-0 items-center justify-between px-3 text-xs font-data-tabular text-on-surface-variant" style={{ width: timeline.width }}>
                        <span>{summary.unallocated} departure flights | {packedUnallocated.laneCount} packed lane{packedUnallocated.laneCount === 1 ? '' : 's'}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPoolCollapsed((current) => !current);
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-high"
                          aria-label={poolCollapsed ? 'Expand unallocated pool' : 'Collapse unallocated pool'}
                        >
                          <span className="material-symbols-outlined text-[17px]">{poolCollapsed ? 'unfold_more' : 'unfold_less'}</span>
                        </button>
                      </div>
                    </div>
                    {poolCollapsed ? null : displayAllocationView.unallocated.length === 0 ? (
                      <div className="flex" style={{ height: poolBodyHeight, minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                        <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-surface-variant bg-surface-container-lowest px-3 text-xs text-on-surface-variant" style={{ width: LABEL_COLUMN_WIDTH }}>
                          Empty
                        </div>
                        <div className="relative shrink-0" style={{ width: timeline.width, height: poolBodyHeight }}>
                          <TimelineGridBackground ticks={timeline.ticks} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex" style={{ height: poolBodyHeight, minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                        <div
                          className="sticky left-0 z-20 flex shrink-0 items-center border-r border-surface-variant bg-surface-container-lowest px-3 text-xs text-on-surface-variant"
                          style={{ width: LABEL_COLUMN_WIDTH }}
                        >
                          Pool
                        </div>
                        <div className="relative shrink-0 overflow-y-auto" style={{ width: timeline.width, height: poolBodyHeight }}>
                          <div className="relative" style={{ height: Math.max(poolBodyHeight, packedPoolHeight) }}>
                            <TimelineGridBackground ticks={timeline.ticks} />
                            {packedUnallocated.items.map(renderUnallocatedBar)}
                          </div>
                        </div>
                      </div>
                    )}
                    {!poolCollapsed && (
                      <button
                        type="button"
                        aria-label="Resize unallocated pool"
                        className="absolute bottom-0 left-0 right-0 z-40 h-2 cursor-ns-resize border-t border-outline-variant bg-surface-container-high hover:bg-primary-container"
                        onPointerDown={(event) => {
                          if (!isRouteActive) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const startY = event.clientY;
                          const startHeight = poolHeight;
                          const handlePointerMove = (moveEvent: PointerEvent) => {
                            setPoolHeight(Math.max(POOL_MIN_HEIGHT, Math.min(POOL_MAX_HEIGHT, startHeight + moveEvent.clientY - startY)));
                          };
                          const stopResize = () => {
                            window.removeEventListener('pointermove', handlePointerMove);
                            window.removeEventListener('pointerup', stopResize);
                            window.removeEventListener('pointercancel', stopResize);
                          };
                          window.addEventListener('pointermove', handlePointerMove);
                          window.addEventListener('pointerup', stopResize, { once: true });
                          window.addEventListener('pointercancel', stopResize, { once: true });
                        }}
                      />
                    )}
                  </div>

                  <div>
                    <div className="flex h-9 items-center border-b border-surface-variant bg-surface-container-low">
                      <div
                        className="sticky left-0 z-30 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-low px-3 text-xs font-semibold text-on-surface"
                        style={{ width: LABEL_COLUMN_WIDTH }}
                      >
                        <span className="material-symbols-outlined text-[17px]">countertops</span>
                        Resource Grid
                      </div>
                      <div className="flex h-full shrink-0 items-center px-3 text-xs font-data-tabular text-on-surface-variant" style={{ width: timeline.width }}>
                        {displayAllocationView.resourceRows.length} counters
                      </div>
                    </div>
                    {displayAllocationView.resourceSections.map((section) => {
                      const resources = displayAllocationView.resourceRows.slice(section.startIndex, section.endIndex + 1);
                      return (
                        <div key={section.id}>
                          {groupByCounterGroup && (
                            <div
                              className="flex h-8 items-center border-b border-surface-variant/70 bg-surface-container text-xs font-semibold text-on-surface-variant"
                              style={{ minWidth: LABEL_COLUMN_WIDTH + timeline.width }}
                            >
                              <div
                                className="sticky left-0 z-20 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container px-3"
                                style={{ width: LABEL_COLUMN_WIDTH }}
                              >
                                <span className="material-symbols-outlined text-[16px]">hub</span>
                                <span className="min-w-0 truncate">{section.name}</span>
                              </div>
                              <div className="flex h-full shrink-0 items-center px-3 font-data-tabular" style={{ width: timeline.width }}>
                                {section.bhs ? `BHS ${section.bhs}` : 'No BHS'}
                              </div>
                            </div>
                          )}
                          {resources.map((resource, offset) => {
                            const rowIndex = section.startIndex + offset;
                            const bars = resourceBarsByRow.get(rowIndex) ?? [];
                            const laneCount = rowLaneCounts.get(rowIndex) ?? 1;
                            const rowHeight = Math.max(RESOURCE_ROW_HEIGHT, 12 + laneCount * (BAR_HEIGHT + 4));
                            const isDropTarget = activeDropRowIndex != null &&
                              rowIndex >= activeDropRowIndex &&
                              rowIndex < activeDropRowIndex + activeDropSpan;
                            const { rowStripeClass, labelStripeClass } = getResourceRowStripeClass(rowIndex, isDropTarget);
                            const hasActiveLocks = resource.activeLocks.length > 0;
                            const activeLockNames = resource.activeLocks.map((activeLock) => activeLock.lock.name).join(', ');
                            return (
                              <div
                                key={`${resource.clusterId}-${resource.label}-${rowIndex}`}
                                className={`flex border-b border-surface-variant/70 transition-colors duration-150 ${rowStripeClass}`}
                                style={{ height: rowHeight, minWidth: LABEL_COLUMN_WIDTH + timeline.width }}
                              >
                                <div
                                  className={`sticky left-0 z-20 flex shrink-0 items-center justify-between gap-2 border-r border-surface-variant px-3 font-data-tabular text-xs font-semibold text-on-surface ${labelStripeClass} ${hasActiveLocks ? 'text-error' : ''}`}
                                  style={{ width: LABEL_COLUMN_WIDTH }}
                                  title={hasActiveLocks ? activeLockNames : undefined}
                                >
                                  <span className="min-w-0 truncate">{resource.label}</span>
                                  {hasActiveLocks && (
                                    <span className="material-symbols-outlined text-[15px]" title={activeLockNames}>
                                      lock
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="relative shrink-0"
                                  style={{ width: timeline.width }}
                                  onDragOver={(event) => handleResourceDragOver(event, rowIndex, displayAllocationView)}
                                  onDragLeave={() => {
                                    scheduleDropPreviewUpdate(null);
                                  }}
                                  onDrop={(event) => handleResourceRowDrop(event, rowIndex, displayAllocationView)}
                                >
                                  <TimelineGridBackground ticks={timeline.ticks} />
                                  {bars.map(renderResourceBar)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
              </div>
            </div>
            {contextMenu && (
              <div
                role="menu"
                aria-label={`${contextMenu.bar.flightNumber} allocation actions`}
                className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setContextMenu(null);
                  }
                }}
              >
                {[
                  ['break', 'call_split', 'Break Shape'],
                  ['reshape', 'dataset_linked', 'Reshape'],
                  ['add', 'add', 'Add Counter'],
                  ['remove', 'remove', 'Remove Counter'],
                  ['override', 'edit_calendar', 'Override Times'],
                  ['unallocate', 'backspace', 'Unallocate'],
                ].map(([action, icon, label]) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    disabled={syncing || (action === 'reshape' && contextMenu.bar.mode !== 'broken')}
                    onClick={() => handleContextAction(action as 'break' | 'reshape' | 'add' | 'remove' | 'override' | 'unallocate')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {overrideDraft && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setOverrideDraft(null)}>
                <form
                  className="w-[min(420px,calc(100vw-32px))] rounded-lg border border-outline-variant bg-surface shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleOverrideSubmit();
                  }}
                >
                  <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold text-on-surface">Override Times</h2>
                      <p className="font-data-tabular text-xs text-on-surface-variant">{overrideDraft.flightLabel}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOverrideDraft(null)}
                      className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant hover:bg-surface-container-high"
                      aria-label="Close override times"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                  <div className="grid gap-3 px-4 py-4">
                    <label className="grid gap-1 text-xs font-label-caps text-on-surface-variant">
                      Start
                      <input
                        type="datetime-local"
                        value={overrideDraft.start}
                        onChange={(event) => setOverrideDraft((current) => current ? { ...current, start: event.target.value } : current)}
                        className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-label-caps text-on-surface-variant">
                      End
                      <input
                        type="datetime-local"
                        value={overrideDraft.end}
                        onChange={(event) => setOverrideDraft((current) => current ? { ...current, end: event.target.value } : current)}
                        className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface"
                      />
                    </label>
                  </div>
                  <div className="flex justify-end gap-2 border-t border-surface-variant px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setOverrideDraft(null)}
                      className="rounded border border-outline-variant px-3 py-1.5 text-sm font-semibold text-on-surface hover:bg-surface-container-high"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={syncing}
                      className="rounded bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </div>
                </form>
              </div>
            )}

            {exportDraft && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !exportingPdf && setExportDraft(null)}>
                <form
                  className="flex max-h-[calc(100vh-32px)] w-[min(1180px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleExportCheckInPdf();
                  }}
                >
                  <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold text-on-surface">Export PDF</h2>
                      <p className="text-xs text-on-surface-variant">A4 landscape, one counter group per page</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExportDraft(null)}
                      disabled={exportingPdf}
                      className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Close export PDF"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                  <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-hidden px-4 py-4 lg:grid-cols-[minmax(360px,380px)_minmax(0,1fr)]">
                    <div className="grid min-w-0 content-start gap-4 overflow-y-auto overflow-x-hidden pr-1">
                      <section className="grid min-w-0 gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-on-surface">Configuration</h3>
                          <p className="text-xs text-on-surface-variant">Set an export-only operational window.</p>
                        </div>
                        <label className="grid min-w-0 gap-1 text-xs font-label-caps text-on-surface-variant">
                          Start Datetime
                          <input
                            type="datetime-local"
                            value={exportDraft.from}
                            onChange={(event) => setExportDraft((current) => current ? { ...current, from: event.target.value } : current)}
                            disabled={exportingPdf}
                            className="w-full min-w-0 rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </label>
                        <label className="grid min-w-0 gap-1 text-xs font-label-caps text-on-surface-variant">
                          End Datetime
                          <input
                            type="datetime-local"
                            value={exportDraft.to}
                            onChange={(event) => setExportDraft((current) => current ? { ...current, to: event.target.value } : current)}
                            disabled={exportingPdf}
                            className="w-full min-w-0 rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </label>
                        <div className="min-w-0 truncate rounded border border-surface-variant bg-surface-container-low px-3 py-2 font-data-tabular text-[11px] text-on-surface-variant">
                          {season ? buildCheckInPdfFileName(season.seasonCode, exportDraft) : 'CheckIn_Allocation_Season.pdf'}
                        </div>
                      </section>
                      <section className="grid min-w-0 gap-3">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-on-surface">Counter Groups</h3>
                            <p className="text-xs text-on-surface-variant">Each selected group renders as one PDF page.</p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              onClick={() => setExportDraft((current) => current ? { ...current, selectedGroupIds: exportGroups.map((group) => group.id) } : current)}
                              disabled={exportingPdf || exportGroups.length === 0}
                              className="rounded border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              All
                            </button>
                            <button
                              type="button"
                              onClick={() => setExportDraft((current) => current ? { ...current, selectedGroupIds: [] } : current)}
                              disabled={exportingPdf || exportGroups.length === 0}
                              className="rounded border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              None
                            </button>
                          </div>
                        </div>
                        <div className="grid max-h-64 min-w-0 gap-2 overflow-y-auto overflow-x-hidden rounded border border-surface-variant bg-surface-container-low p-2">
                          {exportGroups.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-on-surface-variant">Choose a valid timeframe to load Counter Groups.</p>
                          ) : exportGroups.map((group) => (
                            <label key={group.id} className="flex items-center gap-2 rounded border border-transparent px-2 py-1.5 text-sm text-on-surface hover:border-outline-variant hover:bg-surface-container">
                              <input
                                type="checkbox"
                                checked={exportDraft.selectedGroupIds.includes(group.id)}
                                disabled={exportingPdf}
                                onChange={(event) => setExportDraft((current) => {
                                  if (!current) return current;
                                  const selected = new Set(current.selectedGroupIds);
                                  if (event.target.checked) selected.add(group.id);
                                  else selected.delete(group.id);
                                  return { ...current, selectedGroupIds: exportGroups.map((item) => item.id).filter((groupId) => selected.has(groupId)) };
                                })}
                                className="h-4 w-4 accent-primary"
                              />
                              <span className="min-w-0 flex-1 truncate font-semibold">{group.name}</span>
                              <span className="shrink-0 font-data-tabular text-xs text-on-surface-variant">{group.rowCount} rows</span>
                            </label>
                          ))}
                        </div>
                      </section>
                    </div>
                    <CheckInPdfPreviewPanel
                      error={exportPreviewError}
                      preview={exportPreview}
                      records={flightRecords}
                      seasonCode={season?.seasonCode ?? 'Season'}
                    />
                  </div>
                  <div className="flex justify-end gap-2 border-t border-surface-variant px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setExportDraft(null)}
                      disabled={exportingPdf}
                      className="rounded border border-outline-variant px-3 py-1.5 text-sm font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!canExportPdf}
                      className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className={`material-symbols-outlined text-[18px] ${exportingPdf ? 'animate-spin' : ''}`}>{exportingPdf ? 'sync' : 'download'}</span>
                      {exportingPdf ? 'Exporting' : 'Export PDF'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </section>

          {syncProgress && (
            <div className="flex-none rounded border border-surface-variant bg-surface-container-low px-4 py-2 text-sm text-on-surface-variant">
              {syncProgress}
            </div>
          )}
        </main>
      </div>

      {dialogNode}
    </div>
  );
}

export default function CheckInAllocationPage() {
  return (
    <Suspense fallback={
      <LoadingStatusPanel
        progress={buildLoadProgress('Loading check-in allocation...', 20, 'Preparing route')}
        mode="fullscreen"
      />
    }>
      <CheckInAllocationContent />
    </Suspense>
  );
}
