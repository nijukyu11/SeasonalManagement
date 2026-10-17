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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  applyOperationalResourceChangesV1,
  getOperationalScheduleAllocationWindowV1,
  getOperationalSettings,
  getSeasons,
  loadSeasonWorkspaceWindow,
} from '@/lib/remoteStore';
import { revalidateSeasonWorkspaceWindow } from '@/lib/seasonWorkspaceWindowCoordinator';
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
import { addDaysToLocalDateTime, buildDefaultDailyDateRange, readDailyDateRangeQuery } from '@/lib/dailySchedule';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  getCachedSeasons,
  publishSeasonWorkspaceChanged,
  setCachedSeasonData,
  setCachedSeasons,
  type SeasonWorkspaceChangeEvent,
} from '@/lib/seasonDataCache';
import {
  applyLocalModificationBatchDelta,
  type LocalSyncMeta,
} from '@/lib/localSeasonStore';
import { runNativeLocalModificationBatchDeltaResult } from '@/lib/nativeSeasonRepository';
import { getOperatorSessionEpoch } from '@/lib/operatorSessionCacheRegistry';
import {
  findLatestSequencedModificationPatch,
  ganttInteractionArbiter,
} from '@/lib/ganttInteractionArbiter';
import type { SeasonChangeEvent } from '@/lib/seasonChangeEvents';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import { trimUiUndoStack } from '@/lib/uiUndoMemory';
import {
  buildCheckInPdfPreviewPlan,
  exportCheckInAllocationPdf,
  renderCheckInPdfPageElement,
  selectCheckInPdfPreviewGroups,
  type CheckInPdfExportRange,
  type CheckInPdfPreviewPlan,
} from '@/lib/checkinPdfExport';
import {
  buildOperationalDateRange,
  buildOperationalLegPatchAndPreimage,
  getOperationalDayVietnamIso,
  isOperationalScheduleV1Enabled,
  loadFullOperationalScheduleWindow,
  shiftVietnamIsoDate,
  subscribeToOperationalChanges,
  type OperationalWindowSnapshot,
  type OperationalMutationReceipt,
} from '@/lib/operationalScheduleContract';
import {
  useOperationalScheduleStore,
  isRecentOperationalMutationRequestId,
  rememberOperationalMutationRequestId,
  getPendingOperationalMutation,
  setPendingOperationalMutation,
  clearPendingOperationalMutation,
} from '@/lib/operationalScheduleAdapter';
import { getSupabaseClient } from '@/lib/supabase';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import type { FlightModification, FlightRecord, OperationalSettings, Season } from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteActivity, useCachedRouteSearchParams } from '../components/RouteCacheContext';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
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
import { useGanttDragScroll } from '../hooks/useGanttDragScroll';
import { formatUiError } from '@/lib/uiDisplayText';
import {
  formatCheckInCommitFailure,
  getCheckInCommitFailureSource,
  withCheckInCommitFailureSource,
  type CheckInCommitSource,
} from './checkInCommitErrors';
import { shouldRefreshCheckInForWorkspaceChange } from './workspaceRefreshScope';

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

interface CheckInRouteState {
  seasons: Season[];
  season: Season;
  flightRecords: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings | null;
  syncSummary: { pendingCount: number; lastLocalChangeAt: number | null };
  windowKey: string;
}

function readInitialCheckInRouteState(input: {
  targetSeasonId: string | null;
  fromDateTime: string;
  toDateTime: string;
}): CheckInRouteState | null {
  if (isOperationalScheduleV1Enabled()) return null;
  const storeState = useSeasonWorkspaceStore.getState();
  const cachedSeasons = getCachedSeasons() ?? storeState.seasons;
  if (!cachedSeasons || cachedSeasons.length === 0) return null;

  const targetSeason = (input.targetSeasonId ? cachedSeasons.find((item) => item.id === input.targetSeasonId) : null) ?? cachedSeasons[0];
  if (input.targetSeasonId && input.targetSeasonId !== targetSeason.id) return null;

  const windowKey = buildCheckInWindowKey(input.fromDateTime, input.toDateTime);
  const cachedWindow = readWorkspaceWindowSnapshot(storeState.workspaces[targetSeason.id], windowKey);
  if (!cachedWindow?.syncMeta) return null;

  return {
    seasons: cachedSeasons,
    season: targetSeason,
    flightRecords: cachedWindow.records,
    modifications: cachedWindow.modifications,
    settings: storeState.operationalSettings,
    syncSummary: {
      pendingCount: cachedWindow.syncMeta.pendingCount,
      lastLocalChangeAt: cachedWindow.syncMeta.lastLocalChangeAt,
    },
    windowKey,
  };
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
  if (isOperationalScheduleV1Enabled()) {
    return getOperationalDayVietnamIso();
  }
  return new Date().toISOString().slice(0, 10);
}

function formatLocalDateTimeLabel(value: string): string {
  return value.replace('T', ' ');
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

interface DragPointerVisualState {
  pointerId: number;
  activated: boolean;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  flightNumber: string;
  backgroundColor: string;
  textColor: string;
}

type DragState = DragPointerVisualState & (
  | {
      kind: 'unallocated';
      recordId: string;
      dropSpan: number;
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
    }
);

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
  onPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    bar: CheckInResourceBar,
    groupStartIndex: number,
    groupedSpan: number
  ) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
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
    previous.onPointerDown === next.onPointerDown &&
    previous.onPointerMove === next.onPointerMove &&
    previous.onPointerUp === next.onPointerUp &&
    previous.onPointerCancel === next.onPointerCancel &&
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
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
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
      onPointerDown={(event) => onPointerDown(event, bar, groupStartIndex, groupedSpan)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
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
      className={`absolute flex h-6 touch-none cursor-grab items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold transition-[transform,width,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing ${highlighted ? 'z-20' : 'z-10'} ${lockConflict ? 'ring-2 ring-error/80 ring-offset-1 ring-offset-surface-container-lowest' : ''}`}
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
        aria-label="Kéo chỉnh giờ bắt đầu"
        disabled={syncing}
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize disabled:cursor-not-allowed"
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
          title={`Xung đột khóa: ${lockConflict.lock.name}`}
        >
          lock
        </span>
      )}
      <button
        type="button"
        aria-label="Kéo chỉnh giờ kết thúc"
        disabled={syncing}
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize disabled:cursor-not-allowed"
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
  source?: CheckInCommitSource;
  appliedEvents?: SeasonChangeEvent[];
  acknowledgedServerSeq?: number;
};

interface CheckInUndoEntry {
  id: number;
  description: string;
  mods: FlightModification[];
}
const CHECKIN_UNDO_STORAGE_KEY = 'checkin:ui-undo-stack:v1';

function readStoredCheckInUndoStack(): CheckInUndoEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage?.getItem(CHECKIN_UNDO_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return trimUiUndoStack(parsed.filter((item): item is CheckInUndoEntry => (
        item && typeof item === 'object' && typeof item.id === 'number' && typeof item.description === 'string' && Array.isArray(item.mods)
      )));
    }
    return [];
  } catch {
    return [];
  }
}

function persistCheckInUndoStack(stack: CheckInUndoEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (stack.length > 0) {
      window.sessionStorage?.setItem(CHECKIN_UNDO_STORAGE_KEY, JSON.stringify(trimUiUndoStack(stack)));
    } else {
      window.sessionStorage?.removeItem(CHECKIN_UNDO_STORAGE_KEY);
    }
  } catch {
    // Best-effort storage
  }
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
        Chọn ít nhất một Nhóm quầy để xem trước các trang PDF.
      </div>
    );
  }

  return (
    <div className="grid min-h-0 min-w-0 gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Xem trước PDF</h3>
          <p className="text-xs text-on-surface-variant">
            {preview.pages.length} trang · A4 ngang · Khớp trang
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
                Trang {page.pageIndex + 1}: {page.sectionName}
              </span>
              <span>
                {page.scaleMode === 'width' ? 'Khớp chiều rộng' : 'Khớp chiều cao'} · Cỡ chữ vạch {page.barFontSizePt.toFixed(1)}pt
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
  const [fromDateTime, setFromDateTime] = useSessionState('checkin:fromDateTime', defaultRange.from);
  const [toDateTime, setToDateTime] = useSessionState('checkin:toDateTime', defaultRange.to);
  const initialCheckInRouteState = readInitialCheckInRouteState({ targetSeasonId, fromDateTime, toDateTime });

  const [seasons, setSeasons] = useState<Season[]>(() => initialCheckInRouteState?.seasons ?? []);
  const [season, setSeason] = useState<Season | null>(() => initialCheckInRouteState?.season ?? null);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>(() => initialCheckInRouteState?.flightRecords ?? []);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(
    () => initialCheckInRouteState?.modifications ?? new Map()
  );
  const [optimisticAllocationView, setOptimisticAllocationView] = useState<CheckInAllocationView | null>(null);
  const [settings, setSettings] = useState<OperationalSettings | null>(() => initialCheckInRouteState?.settings ?? null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>(
    () => initialCheckInRouteState?.syncSummary ?? {
      pendingCount: 0,
      lastLocalChangeAt: null,
    }
  );
  const [checkInLocalCommitPending, setCheckInLocalCommitPending] = useState(false);
  const [loading, setLoading] = useState(() => !initialCheckInRouteState);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Đang tải phân bổ quầy...', 10, 'Đang chuẩn bị không gian làm việc')
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [pointerDragState, setPointerDragState] = useState<DragState | null>(null);
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
  const suppressNextPointerClickRef = useRef(false);
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
  const checkInUndoStackRef = useRef<CheckInUndoEntry[]>(readStoredCheckInUndoStack());
  const checkInUndoSeqRef = useRef(0);
  const latestCheckInModificationsRef = useRef(modifications);
  const optimisticAllocationViewRef = useRef<CheckInAllocationView | null>(null);
  const checkInCommitAccumulatorRef = useRef<PendingAccumulatedCheckInCommit | null>(null);
  const checkInCommitFlushTimerRef = useRef<number | null>(null);
  const pendingCheckInSyncSummaryRef = useRef<Pick<LocalSyncMeta, 'pendingCount' | 'lastLocalChangeAt'> | null>(null);
  const checkInSyncSummaryTimerRef = useRef<number | null>(null);
  const commitQueueRef = useRef(Promise.resolve());
  const currentMutationRef = useRef<Promise<unknown> | null>(null);
  const loadedWindowKeyRef = useRef<string | null>(initialCheckInRouteState?.windowKey ?? null);
  const fetchServerDataRequestRef = useRef(0);
  const latestRouteWindowRef = useRef<{ seasonId: string | null; windowKey: string }>({
    seasonId: initialCheckInRouteState?.season.id ?? null,
    windowKey: initialCheckInRouteState?.windowKey ?? '',
  });
  const historySeqRef = useRef(0);
  const appliedRangeQueryRef = useRef<string | null>(null);
  const operationalSnapshotRef = useRef<OperationalWindowSnapshot | null>(null);
  const [operationalMutating, setOperationalMutatingState] = useState(false);
  const operationalMutatingRef = useRef(false);
  const setOperationalMutating = useCallback((value: boolean) => {
    operationalMutatingRef.current = value;
    setOperationalMutatingState(value);
  }, []);
  const pendingRevalidateOnSettleRef = useRef(false);
  const operationalRequestIdRef = useRef(0);
  const operationalStoreMutating = useOperationalScheduleStore((s) => s.mutating || s.importing || Boolean(s.unresolvedAttempt));
  const unresolvedAttempt = useOperationalScheduleStore((s) => s.unresolvedAttempt);
  useSessionScrollRestoration('checkin:gantt-scroll', ganttScrollRef);
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow } = useSeasonSync(syncSeasonId, 'checkin');
  const [fetchingServerData, setFetchingServerData] = useState(false);
  const syncInProgress = syncStatus.status === 'syncing';
  const syncing = syncInProgress && syncStatus.mode === 'manual';
  const syncWriteInProgress = syncInProgress || fetchingServerData;
  const isWriteInProgress = isOperationalScheduleV1Enabled()
    ? (operationalMutating || operationalStoreMutating)
    : syncWriteInProgress;
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' ? syncStatus.message : null);
  const fetchProgress = fetchingServerData ? 'Fetching server data' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const currentCheckInWindowKey = buildCheckInWindowKey(fromDateTime, toDateTime);
  useEffect(() => {
    latestRouteWindowRef.current = {
      seasonId: season?.id ?? null,
      windowKey: currentCheckInWindowKey,
    };
  }, [currentCheckInWindowKey, season?.id]);

  const updateCheckInLocalCommitPending = useCallback(() => {
    setCheckInLocalCommitPending(Boolean(
      checkInCommitAccumulatorRef.current ||
      checkInCommitFlushTimerRef.current != null ||
      currentMutationRef.current
    ));
  }, []);

  const clearOptimisticAllocationView = useCallback(() => {
    optimisticAllocationViewRef.current = null;
    setOptimisticAllocationView(null);
  }, []);

  const clearCheckInUndoStack = useCallback(() => {
    checkInUndoStackRef.current = [];
    persistCheckInUndoStack([]);
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
    updateCheckInLocalCommitPending();
  }, [updateCheckInLocalCommitPending]);

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
    syncMeta: LocalSyncMeta | null = null,
    refreshMode: SeasonWorkspaceChangeEvent['refreshMode'] = 'snapshot'
  ) => {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision,
      source,
      affectedIds,
      syncMeta,
      refreshMode,
    });
  }, []);

  const refreshCheckInWindow = useCallback(async (options: { revalidate?: boolean } = {}) => {
    if (isOperationalScheduleV1Enabled()) {
      clearOptimisticAllocationView();
      const requestId = ++operationalRequestIdRef.current;
      const startDate = fromDateTime.slice(0, 10);
      const endDate = toDateTime.slice(0, 10);
      const requestedRangeKey = `${startDate}:${endDate}`;
      const operationalResult = await loadFullOperationalScheduleWindow({
        startDate,
        endDate,
        resourceType: 'checkin',
        fetchWindowFn: (p) => getOperationalScheduleAllocationWindowV1(p),
      });
      if (
        operationalRequestIdRef.current !== requestId ||
        !isRouteActive ||
        `${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}` !== requestedRangeKey
      ) {
        return null;
      }
      operationalSnapshotRef.current = operationalResult.snapshot;
      setFlightRecords(operationalResult.records);
      replaceCheckInModifications(new Map());
      return operationalResult;
    }
    if (!season) return;
    const windowKey = buildCheckInWindowKey(fromDateTime, toDateTime);
    if (options.revalidate) {
      await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'checkin',
        limit: 100000,
      });
    }
    const snapshot = readWorkspaceWindowSnapshot(useSeasonWorkspaceStore.getState().workspaces[season.id], windowKey);
    if (!snapshot?.syncMeta) return null;
    clearOptimisticAllocationView();
    setFlightRecords(snapshot.records);
    replaceCheckInModifications(snapshot.modifications);
    setSyncSummary({
      pendingCount: snapshot.syncMeta.pendingCount,
      lastLocalChangeAt: snapshot.syncMeta.lastLocalChangeAt,
    });
    setCachedSeasonData(season.id, {
      rows: [],
      records: snapshot.records,
      modifications: snapshot.modifications,
      seasonDataVersion: season.dataVersion,
    });
    loadedWindowKeyRef.current = windowKey;
    return snapshot;
  }, [clearOptimisticAllocationView, fromDateTime, isRouteActive, replaceCheckInModifications, season, toDateTime]);

  const tryApplyCachedCheckInRouteWindow = useCallback((): false | 'fresh' | 'stale' => {
    const storeState = useSeasonWorkspaceStore.getState();
    const cachedSeasons = getCachedSeasons() ?? storeState.seasons;
    const cachedSettings = storeState.operationalSettings;
    if (!cachedSeasons || !cachedSettings || cachedSeasons.length === 0) return false;

    const targetSeason = (targetSeasonId ? cachedSeasons.find((item) => item.id === targetSeasonId) : null) ?? cachedSeasons[0];
    if (targetSeasonId && targetSeasonId !== targetSeason.id) return false;

    const windowKey = buildCheckInWindowKey(fromDateTime, toDateTime);
    const freshWindow = readCachedWorkspaceWindow(storeState.workspaces[targetSeason.id], windowKey);
    const cachedWindow = freshWindow ?? readWorkspaceWindowSnapshot(storeState.workspaces[targetSeason.id], windowKey);
    if (!cachedWindow?.syncMeta) return false;

    setLoadError(null);
    clearOptimisticAllocationView();
    setSettings(cachedSettings);
    setSeasons(cachedSeasons);
    setSeason(targetSeason);
    loadedWindowKeyRef.current = windowKey;
    setFlightRecords(cachedWindow.records);
    replaceCheckInModifications(cachedWindow.modifications);
    setSyncSummary({
      pendingCount: cachedWindow.syncMeta.pendingCount,
      lastLocalChangeAt: cachedWindow.syncMeta.lastLocalChangeAt,
    });
    setLoading(false);
    return freshWindow ? 'fresh' as const : 'stale' as const;
  }, [clearOptimisticAllocationView, fromDateTime, replaceCheckInModifications, targetSeasonId, toDateTime]);

  const enqueueLocalMutation = useCallback(function enqueueLocalMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queuedMutation = commitQueueRef.current.then(operation);
    currentMutationRef.current = queuedMutation;
    setCheckInLocalCommitPending(true);
    void queuedMutation.then(() => {
      if (currentMutationRef.current === queuedMutation) {
        currentMutationRef.current = null;
        updateCheckInLocalCommitPending();
      }
    }, () => {
      if (currentMutationRef.current === queuedMutation) {
        currentMutationRef.current = null;
        updateCheckInLocalCommitPending();
      }
    });
    commitQueueRef.current = queuedMutation.then(() => undefined, () => undefined);
    return queuedMutation;
  }, [updateCheckInLocalCommitPending]);

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
      }, 'checkin');
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
        appliedEvents: nativeResult.appliedEvents,
        acknowledgedServerSeq: nativeResult.nextServerSeq,
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
    try {
      const nativeResult = await commitCheckInModificationsNative(seasonId, mods, description);
      if (nativeResult) return nativeResult;
    } catch (error) {
      throw withCheckInCommitFailureSource(error, 'checkin-native');
    }
    const worker = getCheckInCommitWorker();
    if (!worker) {
      try {
        return await commitCheckInModificationsOnMainThread(seasonId, mods, description);
      } catch (error) {
        throw withCheckInCommitFailureSource(error, 'checkin');
      }
    }
    try {
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
    } catch (error) {
      throw withCheckInCommitFailureSource(error, 'checkin-worker');
    }
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
      if (isOperationalScheduleV1Enabled()) {
        if (!isRouteActive) return;
        setLoading(true);
        setLoadError(null);
        const requestId = ++operationalRequestIdRef.current;
        const startDate = fromDateTime.slice(0, 10);
        const endDate = toDateTime.slice(0, 10);
        const requestedRangeKey = `${startDate}:${endDate}`;
        try {
          const loadedSettings = await getOperationalSettings().catch(() => null);
          if (cancelled || operationalRequestIdRef.current !== requestId || !isRouteActive) return;
          if (loadedSettings) setSettings(loadedSettings);
          setLoadProgress(buildLoadProgress('Đang tải khoảng ngày vận hành', 40, `${startDate}..${endDate}`));
          const operationalResult = await loadFullOperationalScheduleWindow({
            startDate,
            endDate,
            resourceType: 'checkin',
            fetchWindowFn: (p) => getOperationalScheduleAllocationWindowV1(p),
          });
          if (
            cancelled ||
            operationalRequestIdRef.current !== requestId ||
            !isRouteActive ||
            `${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}` !== requestedRangeKey
          ) {
            return;
          }
          operationalSnapshotRef.current = operationalResult.snapshot;
          setFlightRecords(operationalResult.records);
          replaceCheckInModifications(new Map());
          setLoading(false);
          return;
        } catch (err) {
          console.error('Error loading operational checkin schedule', err);
          if (!cancelled && operationalRequestIdRef.current === requestId && isRouteActive) {
            const message = formatUiError(err, 'Không thể tải Lịch phân bổ quầy vận hành.');
            setLoadError(message);
            void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
          }
          return;
        } finally {
          if (!cancelled && operationalRequestIdRef.current === requestId) {
            setLoading(false);
          }
        }
      }
      const cachedState = tryApplyCachedCheckInRouteWindow();
      if (cachedState === 'fresh') return;
      setLoading(cachedState !== 'stale');
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Đang tải mùa bay và cấu hình', 15, 'Đang chuẩn bị Phân bổ quầy'));
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
          loadedWindowKeyRef.current = null;
          clearOptimisticAllocationView();
          clearCheckInUndoStack();
          setSeason(null);
          setFlightRecords([]);
          replaceCheckInModifications(new Map());
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          return;
        }

        const targetSeason = (targetSeasonId ? nextSeasons.find((item) => item.id === targetSeasonId) : null) ?? nextSeasons[0];
        if (targetSeasonId && targetSeasonId !== targetSeason.id) {
          router.replace(`/checkin?season=${targetSeason.id}`);
          return;
        }

        setSeason(targetSeason);
        const windowKey = buildCheckInWindowKey(fromDateTime, toDateTime);
        const workspace = useSeasonWorkspaceStore.getState().workspaces[targetSeason.id];
        const freshWindow = readCachedWorkspaceWindow(workspace, windowKey);
        const cachedWindow = freshWindow ?? readWorkspaceWindowSnapshot(workspace, windowKey);
        if (cachedWindow?.syncMeta) {
          loadedWindowKeyRef.current = windowKey;
          setFlightRecords(cachedWindow.records);
          replaceCheckInModifications(cachedWindow.modifications);
          setSyncSummary({
            pendingCount: cachedWindow.syncMeta.pendingCount,
            lastLocalChangeAt: cachedWindow.syncMeta.lastLocalChangeAt,
          });
          if (freshWindow) return;
          setLoading(false);
        }

        setLoadProgress(buildLoadProgress('Đang tải không gian làm việc máy chủ', 35, targetSeason.seasonCode));
        const serverWindow = await loadSeasonWorkspaceWindow({
          seasonId: targetSeason.id,
          dateFrom: fromDateTime.slice(0, 10),
          dateTo: toDateTime.slice(0, 10),
          resourceType: 'checkin',
          limit: 100000,
        });
        if (cancelled) return;
        if (serverWindow) {
          loadedWindowKeyRef.current = windowKey;
          setLoadProgress(buildLoadProgress(
            'Đang chuẩn bị Phân bổ quầy',
            80,
            `${serverWindow.records.length} bản ghi`
          ));
          setFlightRecords(serverWindow.records);
          replaceCheckInModifications(serverWindow.modifications);
          setSyncSummary({
            pendingCount: serverWindow.syncMeta.pendingCount,
            lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
          });
          setCachedSeasonData(targetSeason.id, {
            rows: [],
            records: serverWindow.records,
            modifications: serverWindow.modifications,
            seasonDataVersion: targetSeason.dataVersion,
          });
          useSeasonWorkspaceStore.getState().replaceSeasonWindow({
            seasonId: targetSeason.id,
            season: targetSeason,
            rows: [],
            records: serverWindow.records,
            modifications: serverWindow.modifications,
            syncMeta: serverWindow.syncMeta,
            windowKey,
          });
          publishSeasonWorkspaceChanged({
            seasonId: targetSeason.id,
            localRevision: serverWindow.syncMeta.localRevision,
            source: 'server-window',
            syncMeta: serverWindow.syncMeta,
          });
          return;
        }

        throw new Error('Server check-in allocation window is unavailable.');
      } catch (err) {
        const message = formatUiError(err, 'Không thể tải Lịch phân bổ quầy từ máy chủ.');
        console.error('Error loading check-in allocation', err);
        if (!cancelled) {
          setLoadError(message);
          void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearCheckInUndoStack, clearOptimisticAllocationView, fromDateTime, isRouteActive, replaceCheckInModifications, router, showAlert, targetSeasonId, toDateTime, tryApplyCachedCheckInRouteWindow]);
  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() || !isRouteActive) return;
    const client = getSupabaseClient();
    const sub = subscribeToOperationalChanges(client, {
      onDateInvalidated: (_dates, event) => {
        const requestId = event && typeof event === 'object' && typeof event.request_id === 'string'
          ? event.request_id
          : undefined;
        if (requestId && isRecentOperationalMutationRequestId(requestId)) {
          return;
        }
        // The mutation revision is global: a write on any date, visible or not, stales the snapshot token.
        const storeState = useOperationalScheduleStore.getState();
        if (operationalMutatingRef.current || storeState.mutating || storeState.importing) {
          pendingRevalidateOnSettleRef.current = true;
          return;
        }

        void refreshCheckInWindow({ revalidate: true });
      },
      onReconnect: () => {
        const storeState = useOperationalScheduleStore.getState();
        if (operationalMutatingRef.current || storeState.mutating || storeState.importing) {
          pendingRevalidateOnSettleRef.current = true;
          return;
        }
        void refreshCheckInWindow({ revalidate: true });
      },
    });
    return () => {
      sub.unsubscribe();
    };
  }, [isRouteActive, refreshCheckInWindow]);

  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() || !isRouteActive) return;
    if (operationalMutating || operationalStoreMutating) return;
    if (pendingRevalidateOnSettleRef.current) {
      pendingRevalidateOnSettleRef.current = false;
      void refreshCheckInWindow({ revalidate: true });
    }
  }, [isRouteActive, operationalMutating, operationalStoreMutating, refreshCheckInWindow]);

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

  const visibleCheckInRecordIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    visibleCheckInRecordIdsRef.current = new Set(
      displayAllocationView?.resourceBars.map((bar) => bar.recordId) ?? []
    );
  }, [displayAllocationView?.resourceBars]);

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
    persistCheckInUndoStack(checkInUndoStackRef.current);
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
      const result = await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'checkin',
        limit: 100000,
      }).catch(() => null);
      if (result) {
        const nextModifications = result.modifications;
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
    const queuedWinners: FlightModification[] = [];
    if (season) {
      for (const legId of entry.legIds) {
        const winner = ganttInteractionArbiter.cancel({ seasonId: season.id, targetType: 'modification', targetId: legId });
        if (!winner) continue;
        const applied = useSeasonWorkspaceStore.getState().applyServerModificationPatch({
          seasonId: season.id,
          legId,
          modification: winner.modification,
          serverSeq: winner.serverSeq,
          operatorSessionEpoch: getOperatorSessionEpoch(),
        });
        if (applied === 'applied') queuedWinners.push(winner.modification);
      }
    }
    if (queuedWinners.length > 0 && season) {
      applyOptimisticCheckInModifications(queuedWinners);
      publishWorkspaceChange(season.id, null, 'checkin', queuedWinners.map((mod) => mod.legId), null, 'direct');
    }
    void showAlert({
      title: 'Cập nhật phân bổ quầy thất bại',
      message: formatCheckInCommitFailure({
        error,
        description: entry.description,
        legIds: entry.legIds,
        source: getCheckInCommitFailureSource(error, 'checkin'),
      }),
      tone: 'error',
    });
  }, [applyOptimisticCheckInModifications, clearOptimisticAllocationView, fromDateTime, publishWorkspaceChange, replaceCheckInModifications, season, showAlert, toDateTime]);

  const flushAccumulatedCheckInCommit = useCallback(async (entry: PendingAccumulatedCheckInCommit) => {
    if (!season) return;
    setCheckInLocalCommitPending(true);
    try {
      const result = await persistCheckInModifications(season.id, entry.mods, entry.description);
      if (!result.syncMeta) {
        throw withCheckInCommitFailureSource(
          new Error('Check-in server mutation completed without sync metadata.'),
          result.source ?? 'checkin'
        );
      }
      scheduleSyncSummaryUpdate(result.syncMeta);
      const appliedMods: FlightModification[] = [];
      const submittedModsByLegId = new Map(entry.mods.map((mod) => [mod.legId, mod]));
      let needsRevalidation = false;
      for (const legId of entry.legIds) {
        const localAck = findLatestSequencedModificationPatch(
          result.appliedEvents,
          legId,
          'local-ack',
          submittedModsByLegId.get(legId),
          result.acknowledgedServerSeq,
        );
        const winner = ganttInteractionArbiter.settle(
          { seasonId: season.id, targetType: 'modification', targetId: legId },
          localAck,
        );
        if (!winner) {
          needsRevalidation = true;
          continue;
        }
        const patchResult = useSeasonWorkspaceStore.getState().applyServerModificationPatch({
          seasonId: season.id,
          legId,
          modification: winner.modification,
          serverSeq: winner.serverSeq,
          operatorSessionEpoch: getOperatorSessionEpoch(),
        });
        if (patchResult === 'missing-target' || patchResult === 'invalid-epoch') {
          needsRevalidation = true;
          continue;
        }
        const canonicalMod = useSeasonWorkspaceStore.getState().workspaces[season.id]?.modificationsByLegId.get(legId);
        if (canonicalMod) appliedMods.push(canonicalMod);
      }
      if (appliedMods.length > 0) {
        applyOptimisticCheckInModifications(appliedMods);
        promoteLatestCheckInModificationsForView();
        publishWorkspaceChange(
          season.id,
          result.syncMeta.localRevision,
          result.source ?? 'checkin-worker',
          appliedMods.map((mod) => mod.legId),
          result.syncMeta,
          'direct'
        );
      }
      if (needsRevalidation) {
        useSeasonWorkspaceStore.getState().markSeasonWorkspaceStale(
          season.id,
          'mutation',
          getOperatorSessionEpoch(),
        );
        publishWorkspaceChange(
          season.id,
          result.syncMeta.localRevision,
          result.source ?? 'checkin-worker',
          result.affectedIds ?? entry.legIds,
          result.syncMeta,
          'revalidate'
        );
      }
      if (entry.trackUndo) pushCheckInUndoEntry(entry.undoEntry);
      scheduleCheckInAuditEntry(entry, result);
    } catch (error) {
      await rollbackAccumulatedCheckInCommit(entry, error);
    } finally {
      updateCheckInLocalCommitPending();
    }
  }, [applyOptimisticCheckInModifications, persistCheckInModifications, promoteLatestCheckInModificationsForView, publishWorkspaceChange, pushCheckInUndoEntry, rollbackAccumulatedCheckInCommit, scheduleCheckInAuditEntry, scheduleSyncSummaryUpdate, season, updateCheckInLocalCommitPending]);

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
    for (const legId of legIds) {
      ganttInteractionArbiter.begin({ seasonId: season.id, targetType: 'modification', targetId: legId });
    }
    const entry = mergePendingCheckInCommit(checkInCommitAccumulatorRef.current, {
      legIds: Array.from(new Set(legIds)),
      mods,
      description,
      undoEntry,
      trackUndo,
    });
    checkInCommitAccumulatorRef.current = entry;
    setCheckInLocalCommitPending(true);
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

  const flushPendingCheckInLocalCommit = useCallback(async () => {
    if (checkInCommitFlushTimerRef.current != null) {
      window.clearTimeout(checkInCommitFlushTimerRef.current);
      checkInCommitFlushTimerRef.current = null;
    }
    const entry = checkInCommitAccumulatorRef.current;
    if (entry) {
      checkInCommitAccumulatorRef.current = null;
      setCheckInLocalCommitPending(true);
      await flushAccumulatedCheckInCommit(entry);
    }
    await commitQueueRef.current;
    updateCheckInLocalCommitPending();
  }, [flushAccumulatedCheckInCommit, updateCheckInLocalCommitPending]);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'checkin', {
    blocked: checkInLocalCommitPending || Boolean(draggedGroupId) || resizeState !== null,
    reason: checkInLocalCommitPending
      ? 'Saving check-in allocation'
      : resizeState
        ? 'Resizing check-in allocation'
        : draggedGroupId
          ? 'Dragging check-in allocation'
          : undefined,
    beforeSync: flushPendingCheckInLocalCommit,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'checkin-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
    quiet: true,
    blockingUi: false,
  });

  const shouldDeferCheckInRefresh = useCallback((event: SeasonWorkspaceChangeEvent) => (
    event.refreshMode !== 'direct'
    && (checkInLocalCommitPending || Boolean(draggedGroupId) || resizeState !== null)
  ), [checkInLocalCommitPending, draggedGroupId, resizeState]);

  const shouldHandleCheckInWorkspaceChange = useCallback((event: SeasonWorkspaceChangeEvent) => (
    shouldRefreshCheckInForWorkspaceChange(event, visibleCheckInRecordIdsRef.current)
  ), []);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'checkin',
    shouldDeferRefresh: shouldDeferCheckInRefresh,
    shouldHandleWorkspaceChange: shouldHandleCheckInWorkspaceChange,
    onRefresh: async (event) => {
      await flushPendingCheckInLocalCommit();
      await refreshCheckInWindow({ revalidate: event.refreshMode === 'revalidate' });
    },
  });

  const handleRetryPendingMutation = useCallback(async () => {
    setOperationalMutating(true);
    try {
      const outcome = await useOperationalScheduleStore.getState().retryPendingMutation();
      if (outcome && 'refreshError' in outcome && outcome.refreshError) {
        void showAlert({ title: 'Đã lưu nhưng chưa tải lại được', message: formatUiError(outcome.refreshError), tone: 'warning' });
      } else {
        await refreshCheckInWindow({ revalidate: true });
      }
    } catch (err) {
      void showAlert({ title: 'Thử lại thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setOperationalMutating(false);
    }
  }, [refreshCheckInWindow, setOperationalMutating, showAlert]);

  const commitCheckInModificationBatch = useCallback(async (
    mods: FlightModification[],
    description: string,
    options: CheckInCommitOptions = {}
  ) => {
    if (isOperationalScheduleV1Enabled()) {
      if (mods.length === 0) return;
      if (operationalMutatingRef.current || useOperationalScheduleStore.getState().mutating || useOperationalScheduleStore.getState().importing) {
        return;
      }
      const patches = mods
        .map((mod) => {
          const rec = recordById.get(mod.legId);
          if (!rec) return null;
          const patchFields: Record<string, unknown> = {};
          if (mod.counter !== undefined) patchFields.counter = mod.counter;
          if (mod.checkInStart !== undefined) patchFields.checkInStart = mod.checkInStart;
          if (mod.checkInEnd !== undefined) patchFields.checkInEnd = mod.checkInEnd;
          if (mod.checkInAllocationMode !== undefined) patchFields.checkInAllocationMode = mod.checkInAllocationMode;
          if (mod.checkInCounterWindows !== undefined) patchFields.checkInCounterWindows = mod.checkInCounterWindows;
          if (mod.bhs !== undefined) patchFields.bhs = mod.bhs;
          return buildOperationalLegPatchAndPreimage(rec, patchFields);
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (patches.length === 0) {
        if (options.trackUndo === false) {
          throw new Error('Không thể hoàn tác: chuyến bay mục tiêu không nằm trong phạm vi hiển thị hiện tại.');
        }
        return;
      }

      const currentPayload = JSON.stringify(patches);
      let requestId = crypto.randomUUID();
      let expectedRevision = operationalSnapshotRef.current?.revision ?? '0';

      const pending = getPendingOperationalMutation();
      if (pending && pending.kind === 'apply_resource' && pending.serializedPayload === currentPayload) {
        requestId = pending.requestId;
        expectedRevision = pending.expectedRevision;
      } else if (pending) {
        throw new Error('Thao tác vận hành trước đó chưa được xác nhận. Hãy thử lại yêu cầu đó trước khi thực hiện thao tác mới.');
      } else {
        setPendingOperationalMutation({
          kind: 'apply_resource',
          requestId,
          expectedRevision,
          serializedPayload: currentPayload,
        });
      }

      const undoEntry = options.trackUndo !== false ? buildCheckInUndoEntry(mods, description) : null;

      operationalMutatingRef.current = true;
      setOperationalMutating(true);
      useOperationalScheduleStore.setState({ mutating: true });

      const previousModifications = new Map(latestCheckInModificationsRef.current);
      applyOptimisticCheckInModifications(mods);

      try {
        let receipt: OperationalMutationReceipt;
        try {
          const request = {
            requestId,
            expectedRevision,
            changes: patches,
          };
          rememberOperationalMutationRequestId(request.requestId);
          let unknownFailureCount = 0;
          while (true) {
            try {
              receipt = await applyOperationalResourceChangesV1(request);
              break;
            } catch (error) {
              const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
              const code = typeof rawCode === 'string' ? rawCode : null;
              if (code && /^[0-9A-Z]{5}$/i.test(code) && !code.toUpperCase().startsWith('08') && !code.toUpperCase().startsWith('57')) {
                throw error;
              }
              unknownFailureCount += 1;
              if (unknownFailureCount > 1) {
                await showAlert({
                  title: 'Chưa rõ trạng thái cập nhật quầy',
                  message: 'Không thể xác định kết quả cập nhật do gián đoạn kết nối. Bấm OK để gửi lại đúng yêu cầu này.',
                  tone: 'warning',
                });
              }
            }
          }
        } catch (rpcErr) {
          const rawCode = rpcErr && typeof rpcErr === 'object' && 'code' in rpcErr ? rpcErr.code : null;
          const code = typeof rawCode === 'string' ? rawCode : null;
          if (code && /^[0-9A-Z]{5}$/i.test(code) && !code.toUpperCase().startsWith('08') && !code.toUpperCase().startsWith('57')) {
            clearPendingOperationalMutation(requestId);
          }
          latestCheckInModificationsRef.current = previousModifications;
          setModifications(previousModifications);
          clearOptimisticAllocationView();
          void refreshCheckInWindow().catch(() => undefined);
          void showAlert({
            title: 'Cập nhật phân bổ quầy thất bại',
            message: formatUiError(rpcErr),
            tone: 'error',
          });
          return;
        }

        if (receipt.status !== 'committed') {
          clearPendingOperationalMutation(requestId);
          latestCheckInModificationsRef.current = previousModifications;
          setModifications(previousModifications);
          clearOptimisticAllocationView();
          void refreshCheckInWindow().catch(() => undefined);
          void showAlert({
            title: 'Cập nhật phân bổ quầy thất bại',
            message: formatUiError(receipt.message || `Thao tác ${receipt.status}`),
            tone: 'error',
          });
          return;
        }

        clearPendingOperationalMutation(requestId);
        if (receipt.revision) {
          operationalSnapshotRef.current = {
            revision: receipt.revision,
            token: operationalSnapshotRef.current?.token ?? '',
          };
        }
        if (undoEntry) {
          pushCheckInUndoEntry(undoEntry);
        }

        try {
          await refreshCheckInWindow({ revalidate: true });
        } catch (refreshErr) {
          console.error('Failed to refresh checkin window after commit', refreshErr);
          void showAlert({
            title: 'Tải lại giao diện thất bại',
            message: `Các thay đổi đã được lưu (phiên bản ${receipt.revision}), nhưng không thể tải lại màn hình phân bổ quầy: ${formatUiError(refreshErr)}`,
            tone: 'warning',
          });
        }
      } finally {
        setOperationalMutating(false);
        useOperationalScheduleStore.setState({ mutating: false });
      }
      return;
    }
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
  }, [applyOptimisticCheckInModifications, buildCheckInUndoEntry, clearOptimisticAllocationView, pushCheckInUndoEntry, recordById, refreshCheckInWindow, scheduleAccumulatedCheckInCommit, season, setOperationalMutating, showAlert]);

  const commitOneModification = useCallback(async (
    mod: FlightModification,
    description: string,
    options: CheckInCommitOptions = {}
  ) => {
    return commitCheckInModificationBatch([mod], description, options);
  }, [commitCheckInModificationBatch]);

  const handleUndoCheckInAllocation = useCallback(async () => {
    if (isWriteInProgress) return;
    const entry = checkInUndoStackRef.current.pop();
    persistCheckInUndoStack(checkInUndoStackRef.current);
    if (!entry) return;
    try {
      await commitCheckInModificationBatch(entry.mods, `Undo ${entry.description}`, { trackUndo: false });
    } catch (err) {
      checkInUndoStackRef.current.push(entry);
      persistCheckInUndoStack(checkInUndoStackRef.current);
      void showAlert({ title: 'Hoàn tác thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitCheckInModificationBatch, isWriteInProgress, showAlert]);

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
    if (isWriteInProgress) return;
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
  }, [isWriteInProgress, timeline.width, updateSnapLine]);

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
    if (!season || syncInProgress) return;
    setResizeState(null);
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Lưu thất bại', message: formatUiError(result.message ?? 'Lưu thất bại.'), tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Lưu thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [season, showAlert, syncInProgress, syncNow]);

  const fetchServerData = useCallback(async () => {
    if (isWriteInProgress) return;
    if (isOperationalScheduleV1Enabled()) {
      await refreshCheckInWindow({ revalidate: true });
      return;
    }
    if (!season || fetchingServerData || syncInProgress) return;
    const windowKey = buildCheckInWindowKey(fromDateTime, toDateTime);
    if (checkInCommitAccumulatorRef.current || checkInCommitFlushTimerRef.current != null) {
      void showAlert({
        title: 'Tải dữ liệu bị chặn',
        message: 'Hãy lưu các thay đổi phân bổ quầy trước khi tải dữ liệu từ máy chủ.',
        tone: 'warning',
      });
      return;
    }
    const requestId = ++fetchServerDataRequestRef.current;
    const requestedSeasonId = season.id;
    const hasRouteDataLoaded = loadedWindowKeyRef.current === windowKey;
    setResizeState(null);
    setFetchingServerData(true);
    if (!hasRouteDataLoaded) setLoadError(null);
    setLoadProgress(buildLoadProgress('Đang tải không gian làm việc máy chủ', 35, season.seasonCode));
    try {
      await currentMutationRef.current;
      await commitQueueRef.current;
      const serverWindow = await revalidateSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'checkin',
        limit: 100000,
      }, {
        force: true,
        initiator: 'immediate',
      });
      if (!serverWindow?.syncMeta) throw new Error('Server check-in allocation window is unavailable.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== windowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = windowKey;
      setLoadProgress(buildLoadProgress('Đang chuẩn bị Phân bổ quầy', 80, `${serverWindow.records.length} bản ghi`));
      setFlightRecords(serverWindow.records);
      replaceCheckInModifications(serverWindow.modifications);
      setSyncSummary({
        pendingCount: serverWindow.syncMeta.pendingCount,
        lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
      });
      setCachedSeasonData(season.id, {
        rows: [],
        records: serverWindow.records,
        modifications: serverWindow.modifications,
        seasonDataVersion: season.dataVersion,
      });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: season.id,
        season,
        rows: [],
        records: serverWindow.records,
        modifications: serverWindow.modifications,
        syncMeta: serverWindow.syncMeta,
        windowKey,
      });
      publishSeasonWorkspaceChanged({
        seasonId: season.id,
        localRevision: serverWindow.syncMeta.localRevision,
        source: 'server-window',
        syncMeta: serverWindow.syncMeta,
      });
    } catch (err) {
      const message = formatUiError(err, 'Không thể tải dữ liệu phân bổ quầy từ máy chủ.');
      if (!hasRouteDataLoaded) setLoadError(message);
      void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [fetchingServerData, fromDateTime, isWriteInProgress, refreshCheckInWindow, replaceCheckInModifications, season, showAlert, syncInProgress, toDateTime]);

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
    if ((!isOperationalScheduleV1Enabled() && !season) || !settings || !exportDraft) return;
    if (!isValidCheckInExportRange(exportDraft)) {
      void showAlert({
        title: 'Xuất PDF thất bại',
        message: 'Hãy chọn khoảng thời gian hợp lệ với mốc Đến sau mốc Từ.',
        tone: 'error',
      });
      return;
    }
    if (exportDraft.selectedGroupIds.length === 0) {
      void showAlert({
        title: 'Xuất PDF thất bại',
        message: 'Hãy chọn ít nhất một Nhóm quầy trước khi xuất.',
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
        seasonCode: season?.seasonCode ?? 'OPS',
        fileName: buildCheckInPdfFileName(season?.seasonCode ?? 'OPS', exportDraft),
      });
      notifyExportCompleted(result.saveResult);
      setExportDraft(null);
    } catch (err) {
      void showAlert({ title: 'Xuất PDF thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã phân bổ ${formatCheckInFlightLabel(record)} vào quầy ${displayCheckInCounter(startCounter)}`);
    } catch (err) {
      void showAlert({ title: 'Phân bổ thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã di chuyển phân bổ quầy của ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Di chuyển thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, settings, showAlert]);

  const handleResizeCommit = useCallback(async (state: ResizeState, endClientX: number) => {
    const view = displayAllocationView;
    if (isWriteInProgress || !view || !settings) return;
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
      await commitOneModification(mod, `Đã kéo chỉnh thời gian phân bổ của ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Kéo chỉnh thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, isWriteInProgress, settings, showAlert, timeline.width, timelinePixelsPerMinute]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    if (!resizeState) return undefined;
    document.body.style.cursor = 'ew-resize';
    const handlePointerMove = (event: PointerEvent) => {
      scheduleSnapLineUpdate(resizeState, event.clientX);
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
  }, [clearSnapLine, handleResizeCommit, isRouteActive, resizeState, scheduleSnapLineUpdate]);

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
      void showAlert({ title: 'Toàn màn hình thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [showAlert]);

  const handleTimelineZoom = useCallback((direction: -1 | 1) => {
    promoteLatestCheckInModificationsForView();
    setTimelinePixelsPerMinute((current) => clampTimelinePixelsPerMinute(current + direction * TIMELINE_ZOOM_STEP));
  }, [promoteLatestCheckInModificationsForView, setTimelinePixelsPerMinute]);

  const canZoomOut = timelinePixelsPerMinute > MIN_TIMELINE_PIXELS_PER_MINUTE;
  const canZoomIn = timelinePixelsPerMinute < MAX_TIMELINE_PIXELS_PER_MINUTE;

  const commitCheckInPoolDrop = useCallback((drag: Extract<DragState, { kind: 'allocated' }>) => {
    if (isWriteInProgress) return;
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
      ? `Đã bớt quầy ${displayCheckInCounter(drag.counter)} khỏi ${formatCheckInFlightLabel(record)}`
      : `Đã hủy phân bổ ${formatCheckInFlightLabel(record)}`;
    void commitOneModification(
      mod,
      description
    ).catch((err) => {
      void showAlert({ title: 'Hủy phân bổ thất bại', message: formatUiError(err), tone: 'error' });
    });
  }, [commitOneModification, displayAllocationView, getEffectiveRecord, isWriteInProgress, settings, showAlert]);

  const resolveCheckInPointerDrop = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY);
    const drag = dragStateRef.current;
    if (!target || !drag || !displayAllocationView) return { kind: 'none' as const };
    if (target.closest('[data-checkin-pool-drop="true"]')) return { kind: 'pool' as const };
    const rowTarget = target.closest('[data-checkin-drop-index]');
    const hoveredRowIndex = Number(rowTarget?.getAttribute('data-checkin-drop-index') ?? '');
    if (!Number.isInteger(hoveredRowIndex)) return { kind: 'none' as const };
    const dropTarget = resolveDropTargetRow(drag, hoveredRowIndex, displayAllocationView);
    return { kind: 'row' as const, ...dropTarget };
  }, [displayAllocationView]);

  const updateCheckInPointerPreview = useCallback((clientX: number, clientY: number) => {
    const drag = dragStateRef.current;
    if (!drag?.activated) return;
    const target = resolveCheckInPointerDrop(clientX, clientY);
    scheduleDropPreviewUpdate(target.kind === 'row' ? target.previewStartRow : null);
    setPoolDropActiveIfChanged(target.kind === 'pool' && drag.kind === 'allocated');
  }, [resolveCheckInPointerDrop, scheduleDropPreviewUpdate, setPoolDropActiveIfChanged]);

  const {
    start: startCheckInDragScroll,
    updatePointer: updateCheckInDragScrollPointer,
    stop: stopCheckInDragScroll,
  } = useGanttDragScroll({
    scrollRef: ganttScrollRef,
    edgeThreshold: EDGE_SCROLL_THRESHOLD,
    maxEdgeSpeed: EDGE_SCROLL_MAX_SPEED,
    onAfterScroll: ({ clientX, clientY }) => updateCheckInPointerPreview(clientX, clientY),
  });

  const releaseCheckInInteraction = useCallback((recordId: string) => {
    if (!season) return;
    const winner = ganttInteractionArbiter.cancel({ seasonId: season.id, targetType: 'modification', targetId: recordId });
    if (!winner) return;
    const applied = useSeasonWorkspaceStore.getState().applyServerModificationPatch({
      seasonId: season.id,
      legId: recordId,
      modification: winner.modification,
      serverSeq: winner.serverSeq,
      operatorSessionEpoch: getOperatorSessionEpoch(),
    });
    if (applied !== 'applied') return;
    applyOptimisticCheckInModifications([winner.modification]);
    publishWorkspaceChange(season.id, winner.serverSeq, 'checkin', [recordId], null, 'direct');
  }, [applyOptimisticCheckInModifications, publishWorkspaceChange, season]);

  const clearCheckInPointerDrag = useCallback(() => {
    stopCheckInDragScroll();
    dragStateRef.current = null;
    setPointerDragState(null);
    setDraggedGroupId(null);
    clearDropPreview();
    setPoolDropActiveIfChanged(false);
  }, [clearDropPreview, setPoolDropActiveIfChanged, stopCheckInDragScroll]);

  const handleUnallocatedPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, item: CheckInPackedItem) => {
    if (!isRouteActive || isWriteInProgress || event.button !== 0) return;
    const color = getCheckInColorToken(item.record, settings);
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      kind: 'unallocated',
      recordId: item.record.id,
      dropSpan: item.requiredCounters,
      pointerId: event.pointerId,
      activated: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      flightNumber: `${formatCheckInFlightLabel(item.record)} (${item.requiredCounters})`,
      backgroundColor: color.backgroundColor,
      textColor: color.textColor,
    };
  }, [isRouteActive, isWriteInProgress, settings]);

  const handleResourceBarPointerDown = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    bar: CheckInResourceBar,
    groupStartIndex: number,
    groupedSpan: number
  ) => {
    if (resizeDragGuardRef.current || resizeState) {
      return;
    }
    if (!isRouteActive || isWriteInProgress || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const record = recordById.get(bar.recordId);
    const color = getCheckInColorToken(record ?? { airline: bar.flightNumber.slice(0, 2), flightNumber: bar.flightNumber, rawFlightNumber: bar.flightNumber }, settings);
    dragStateRef.current = {
      kind: 'allocated',
      recordId: bar.recordId,
      counter: bar.counter,
      counterIndex: bar.counterIndex,
      groupStartIndex,
      dragRowOffset: bar.counterIndex - groupStartIndex,
      dropSpan: bar.mode === 'grouped' ? groupedSpan : 1,
      mode: bar.mode,
      pointerId: event.pointerId,
      activated: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      flightNumber: bar.flightNumber,
      backgroundColor: color.backgroundColor,
      textColor: color.textColor,
    };
  }, [isRouteActive, isWriteInProgress, recordById, resizeState, settings]);

  const handleCheckInPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY);
    if (!current.activated && distance < 4) return;
    event.preventDefault();
    if (!current.activated && season) {
      ganttInteractionArbiter.begin({ seasonId: season.id, targetType: 'modification', targetId: current.recordId });
    }
    const next: DragState = {
      ...current,
      activated: true,
      currentClientX: current.kind === 'allocated' ? current.currentClientX : event.clientX,
      currentClientY: event.clientY,
    };
    dragStateRef.current = next;
    setPointerDragState(next);
    setDraggedGroupId(next.recordId);
    setActiveDropSpanIfChanged(next.dropSpan);
    updateCheckInPointerPreview(event.clientX, event.clientY);
    if (!current.activated) {
      startCheckInDragScroll({ clientX: event.clientX, clientY: event.clientY }, next.kind === 'allocated' ? 'vertical' : 'both');
    } else {
      updateCheckInDragScrollPointer({ clientX: event.clientX, clientY: event.clientY });
    }
  }, [season, setActiveDropSpanIfChanged, startCheckInDragScroll, updateCheckInDragScrollPointer, updateCheckInPointerPreview]);

  const handleCheckInPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.activated) {
      clearCheckInPointerDrag();
      return;
    }
    suppressNextPointerClickRef.current = true;
    const target = resolveCheckInPointerDrop(event.clientX, event.clientY);
    const recordId = drag.recordId;
    releaseCheckInInteraction(recordId);
    clearCheckInPointerDrag();
    if (isWriteInProgress) return;
    if (target.kind === 'row') {
      if (drag.kind === 'unallocated') void handleAllocate(recordId, target.counter);
      else void handleMove(drag, target.rowIndex);
      return;
    }
    if (target.kind === 'pool' && drag.kind === 'allocated') commitCheckInPoolDrop(drag);
  }, [clearCheckInPointerDrag, commitCheckInPoolDrop, handleAllocate, handleMove, isWriteInProgress, releaseCheckInInteraction, resolveCheckInPointerDrop]);

  const handleCheckInPointerCancel = useCallback(() => {
    const drag = dragStateRef.current;
    if (drag?.activated) {
      suppressNextPointerClickRef.current = true;
      releaseCheckInInteraction(drag.recordId);
    }
    clearCheckInPointerDrag();
  }, [clearCheckInPointerDrag, releaseCheckInInteraction]);

  useEffect(() => {
    if (!pointerDragState) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCheckInPointerCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [handleCheckInPointerCancel, pointerDragState]);

  const handleBreakShape = useCallback(async (bar: CheckInResourceBar) => {
    const record = getEffectiveRecord(bar.recordId);
    if (!record) return;
    try {
      const mod = breakCheckInAllocation({ record, currentCounter: record.counter });
      await commitOneModification(mod, `Đã tách dải quầy của ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Tách quầy thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã gộp dải quầy của ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Gộp quầy thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã thêm quầy cho ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Thêm quầy thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã bớt quầy khỏi ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Bớt quầy thất bại', message: formatUiError(err), tone: 'error' });
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
      await commitOneModification(mod, `Đã ghi đè thời gian phân bổ của ${formatCheckInFlightLabel(record)}`);
      setOverrideDraft(null);
    } catch (err) {
      void showAlert({ title: 'Ghi đè thời gian thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitOneModification, displayAllocationView, flightRecords, getEffectiveRecord, overrideDraft, settings, showAlert]);

  const handleUnallocate = useCallback(async (recordId: string) => {
    const record = getEffectiveRecord(recordId);
    if (!record) return;
    try {
      await commitOneModification(unallocateCheckInRecord(record), `Đã hủy phân bổ ${formatCheckInFlightLabel(record)}`);
    } catch (err) {
      void showAlert({ title: 'Hủy phân bổ thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitOneModification, getEffectiveRecord, showAlert]);

  const handleUnallocateAllInPeriod = useCallback(async () => {
    if (isWriteInProgress) return;
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
        `Unallocated all counters from ${formatLocalDateTimeLabel(fromDateTime)} to ${formatLocalDateTimeLabel(toDateTime)}`
      );
    } catch (err) {
      void showAlert({ title: 'Hủy phân bổ toàn bộ thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [commitCheckInModificationBatch, displayAllocationView, fromDateTime, getEffectiveRecord, isWriteInProgress, settings, showAlert, toDateTime]);

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
    if (suppressNextPointerClickRef.current) {
      suppressNextPointerClickRef.current = false;
      return;
    }
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
        aria-label={`${label}, ${formatLocalDateTimeLabel(item.window.start)} to ${formatLocalDateTimeLabel(item.window.end)}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={(event) => handleUnallocatedPointerDown(event, item)}
        onPointerMove={handleCheckInPointerMove}
        onPointerUp={handleCheckInPointerUp}
        onPointerCancel={handleCheckInPointerCancel}
        className="absolute flex h-6 touch-none cursor-grab items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold transition-[transform,width,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing"
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
        syncing={isWriteInProgress}
        resizing={resizeState !== null}
        onPointerDown={handleResourceBarPointerDown}
        onPointerMove={handleCheckInPointerMove}
        onPointerUp={handleCheckInPointerUp}
        onPointerCancel={handleCheckInPointerCancel}
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
    handleCheckInPointerCancel,
    handleCheckInPointerMove,
    handleCheckInPointerUp,
    handleResourceBarPointerDown,
    handleResourceBarHoverEnd,
    handleResourceBarHoverStart,
    handleResourceBarSelect,
    highlightedGroupId,
    openBarContextMenu,
    recordById,
    resizeState,
    settings,
    startResizeInteraction,
    isWriteInProgress,
    timeline.width,
  ]);

  return (
    <div className="flex h-dvh overflow-hidden bg-surface text-on-surface font-sans" onClick={() => setContextMenu(null)}>
      <div className="flex h-dvh min-w-0 flex-1 flex-col bg-surface">
        <header className="z-30 flex flex-none items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Phân bổ quầy</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {isOperationalScheduleV1Enabled() ? 'Lịch ngày vận hành' : (season ? buildSeasonDisplayLabel(season) : 'Chưa chọn mùa bay')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!isOperationalScheduleV1Enabled() && (
              <select
                value={season?.id ?? ''}
                onChange={(event) => router.push(`/checkin?season=${event.target.value}`)}
                disabled={seasons.length === 0 || syncing}
                className="min-w-[200px] cursor-pointer rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm font-medium text-on-surface shadow-sm transition-colors hover:bg-surface-container-high focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {seasons.length === 0 ? (
                  <option value="">Không có mùa bay</option>
                ) : seasons.map((item) => (
                  <option key={item.id} value={item.id}>{buildSeasonDisplayLabel(item)}</option> 
                ))}
              </select>
            )}
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
                <FetchServerUpdatesButton
                  fetching={fetchingServerData}
                  progress={fetchProgress}
                  disabled={syncInProgress}
                  onFetch={fetchServerData}
                />
                <SyncActionButton
                  syncing={syncInProgress}
                  pendingCount={syncPendingCount}
                  progress={syncProgress}
                  onSync={handleSync}
                />
              </>
            )}
          </div>
        </header>
        {unresolvedAttempt && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-6 py-2.5 text-sm text-on-surface">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-warning">warning</span>
              <p className="text-pretty">
                Có thao tác check-in chưa xác nhận trên server (Yêu cầu {unresolvedAttempt.requestId.slice(0, 8)}…). Các thao tác khác đang bị tạm khóa.
              </p>
            </div>
            <button
              type="button"
              disabled={operationalMutating}
              onClick={() => void handleRetryPendingMutation()}
              className="rounded border border-primary bg-primary px-3 py-1.5 font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {operationalMutating ? 'Đang gửi lại…' : 'Gửi lại yêu cầu'}
            </button>
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <section className="flex-none rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-variant px-4 py-3">
              <fieldset disabled={isOperationalScheduleV1Enabled() && isWriteInProgress} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  Từ
                  <input
                    type="datetime-local"
                    value={fromDateTime}
                    onChange={(event) => {
                      promoteLatestCheckInModificationsForView();
                      const nextFrom = event.target.value;
                      setFromDateTime(nextFrom);
                      if (nextFrom) setToDateTime(addDaysToLocalDateTime(nextFrom, 1));
                    }}
                    className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  Đến
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
                {isOperationalScheduleV1Enabled() ? (
                  <>
                    <button
                      onClick={() => {
                        promoteLatestCheckInModificationsForView();
                        const range = buildOperationalDateRange('today');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
                    >
                      <span className="material-symbols-outlined text-[16px]">today</span>
                      Hôm nay
                    </button>
                    <button
                      onClick={() => {
                        promoteLatestCheckInModificationsForView();
                        const range = buildOperationalDateRange('tomorrow');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high"
                    >
                      Ngày mai
                    </button>
                    <button
                      onClick={() => {
                        promoteLatestCheckInModificationsForView();
                        const range = buildOperationalDateRange('next7days');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high"
                    >
                      7 ngày
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleToday}
                      className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
                    >
                      <span className="material-symbols-outlined text-[16px]">today</span>
                      Hôm nay
                    </button>
                    {[1, 2, 3].map((days) => (
                      <button
                        key={days}
                        onClick={() => handleQuickRange(days)}
                        className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high"
                      >
                        {days}N
                      </button>
                    ))}
                  </>
                )}
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
                  Gộp theo đảo quầy
                </label>
              </fieldset>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-container px-3 py-1 text-xs font-bold text-on-primary-container">CHƯA XẾP {summary.unallocated}</span>
                <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">ĐÃ PHÂN BỔ {summary.allocatedFlights}</span>
                <span className="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container">KHỐI QUẦY {summary.counterBlocks}</span>
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
            className={`relative min-h-0 flex-1 overflow-hidden rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm ${isGanttFullscreen ? 'fixed inset-0 z-[100] h-dvh w-screen rounded-none border-0 bg-surface shadow-none' : ''}`}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 flex-none items-center justify-between border-b border-surface-variant bg-surface-container-low px-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-on-surface">
                  <span className="material-symbols-outlined text-[18px]">view_timeline</span>
                  Gantt phân bổ quầy
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUnallocateAllInPeriod();
                    }}
                    disabled={isWriteInProgress || summary.counterBlocks === 0}
                    className="flex h-7 items-center gap-1.5 rounded border border-outline-variant bg-surface-container-lowest px-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Hủy phân bổ toàn bộ quầy trong khoảng thời gian đã chọn"
                    title="Hủy phân bổ toàn bộ quầy trong khoảng thời gian đã chọn"
                  >
                    <span className="material-symbols-outlined text-[18px]">playlist_remove</span>
                    Hủy phân bổ tất cả
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenExportDialog();
                    }}
                    disabled={(!isOperationalScheduleV1Enabled() && !season) || !settings || loading || exportingPdf || isWriteInProgress}
                    className="flex h-7 items-center gap-1.5 rounded border border-outline-variant bg-surface-container-lowest px-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Xuất PDF"
                    title="Xuất PDF"
                  >
                    <span className={`material-symbols-outlined text-[18px] ${exportingPdf ? 'animate-spin' : ''}`}>{exportingPdf ? 'sync' : 'picture_as_pdf'}</span>
                    Xuất PDF
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTimelineZoom(-1);
                    }}
                    disabled={!canZoomOut}
                    className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Thu nhỏ dòng thời gian"
                    title="Thu nhỏ"
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
                    aria-label="Phóng to dòng thời gian"
                    title="Phóng to"
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
                    aria-label={isGanttFullscreen ? 'Thoát toàn màn hình Gantt' : 'Toàn màn hình Gantt'}
                    title={isGanttFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
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
                <div className="text-sm font-semibold text-error">Không thể tải dữ liệu phân bổ quầy</div>
                <div className="max-w-xl text-sm text-on-surface-variant">{loadError}</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingServerData}
                    progress={fetchProgress}
                    disabled={syncInProgress}
                    onFetch={fetchServerData}
                  />
                )}
              </div>
            ) : !isOperationalScheduleV1Enabled() && !season ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-on-surface-variant">
                <div>Không có dữ liệu mùa bay.</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingServerData}
                    progress={fetchProgress}
                    disabled={syncInProgress}
                    onFetch={fetchServerData}
                  />
                )}
              </div>
            ) : !displayAllocationView || !timeline.ticks ? (
              <div className="flex h-full items-center justify-center text-sm text-error">
                {allocationResult.error ?? timeline.error ?? 'Màn hình phân bổ quầy hiện không khả dụng.'}
              </div>
            ) : (
              <div
                ref={ganttScrollRef}
                className="h-full overflow-auto"
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
                    data-checkin-pool-drop="true"
                    className={`sticky top-14 z-30 border-b border-surface-variant bg-surface-container-lowest shadow-sm transition-colors duration-150 ${poolDropActive ? 'ring-2 ring-primary/50 bg-primary-container/20' : ''}`}
                    style={{ height: poolCollapsed ? POOL_HEADER_HEIGHT : poolHeight }}
                  >
                    <div className="flex h-9 items-center border-b border-surface-variant bg-surface-container-low">
                      <div
                        className="sticky left-0 z-30 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-low px-3 text-xs font-semibold text-on-surface"
                        style={{ width: LABEL_COLUMN_WIDTH }}
                      >
                        <span className="material-symbols-outlined text-[17px]">inventory_2</span>
                        Chưa phân bổ
                      </div>
                      <div className="flex h-full shrink-0 items-center justify-between px-3 text-xs font-data-tabular text-on-surface-variant" style={{ width: timeline.width }}>
                        <span>{summary.unallocated} chuyến bay đi | {packedUnallocated.laneCount} luồng xếp gọn</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPoolCollapsed((current) => !current);
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-high"
                          aria-label={poolCollapsed ? 'Mở rộng khu vực chưa phân bổ' : 'Thu gọn khu vực chưa phân bổ'}
                        >
                          <span className="material-symbols-outlined text-[17px]">{poolCollapsed ? 'unfold_more' : 'unfold_less'}</span>
                        </button>
                      </div>
                    </div>
                    {poolCollapsed ? null : displayAllocationView.unallocated.length === 0 ? (
                      <div className="flex" style={{ height: poolBodyHeight, minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                        <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-surface-variant bg-surface-container-lowest px-3 text-xs text-on-surface-variant" style={{ width: LABEL_COLUMN_WIDTH }}>
                          Trống
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
                          Chờ phân bổ
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
                        aria-label="Kéo đổi kích thước khu vực chưa phân bổ"
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
                        Lưới quầy
                      </div>
                      <div className="flex h-full shrink-0 items-center px-3 text-xs font-data-tabular text-on-surface-variant" style={{ width: timeline.width }}>
                        {displayAllocationView.resourceRows.length} quầy
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
                                {section.bhs ? `BHS ${section.bhs}` : 'Không có BHS'}
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
                                  data-checkin-drop-index={rowIndex}
                                  className="relative shrink-0"
                                  style={{ width: timeline.width }}
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
                  ['break', 'call_split', 'Tách dải quầy'],
                  ['reshape', 'dataset_linked', 'Gộp dải quầy'],
                  ['add', 'add', 'Thêm quầy'],
                  ['remove', 'remove', 'Bớt quầy'],
                  ['override', 'edit_calendar', 'Ghi đè thời gian'],
                  ['unallocate', 'backspace', 'Hủy phân bổ'],
                ].map(([action, icon, label]) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    disabled={isWriteInProgress || (action === 'reshape' && contextMenu.bar.mode !== 'broken')}
                    onClick={() => handleContextAction(action as 'break' | 'reshape' | 'add' | 'remove' | 'override' | 'unallocate')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {pointerDragState && (
              <div
                className="pointer-events-none fixed z-[200] flex items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold opacity-90 shadow-xl"
                style={{
                  left: pointerDragState.currentClientX - pointerDragState.offsetX,
                  top: pointerDragState.currentClientY - pointerDragState.offsetY,
                  width: pointerDragState.width,
                  height: pointerDragState.height,
                  background: pointerDragState.backgroundColor,
                  backgroundColor: pointerDragState.backgroundColor,
                  color: pointerDragState.textColor,
                }}
              >
                <span className="truncate">{pointerDragState.flightNumber}</span>
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
                      <h2 className="text-sm font-semibold text-on-surface">Ghi đè thời gian</h2>
                      <p className="font-data-tabular text-xs text-on-surface-variant">{overrideDraft.flightLabel}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOverrideDraft(null)}
                      className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant hover:bg-surface-container-high"
                      aria-label="Đóng ghi đè thời gian"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                  <div className="grid gap-3 px-4 py-4">
                    <label className="grid gap-1 text-xs font-label-caps text-on-surface-variant">
                      Bắt đầu
                      <input
                        type="datetime-local"
                        value={overrideDraft.start}
                        onChange={(event) => setOverrideDraft((current) => current ? { ...current, start: event.target.value } : current)}
                        className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-label-caps text-on-surface-variant">
                      Kết thúc
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
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={isWriteInProgress}
                      className="rounded bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Áp dụng
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
                      <h2 className="text-sm font-semibold text-on-surface">Xuất PDF</h2>
                      <p className="text-xs text-on-surface-variant">Khổ A4 ngang, mỗi nhóm quầy một trang</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExportDraft(null)}
                      disabled={exportingPdf}
                      className="flex h-8 w-8 items-center justify-center rounded border border-outline-variant hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Đóng xuất PDF"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                  <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-hidden px-4 py-4 lg:grid-cols-[minmax(360px,380px)_minmax(0,1fr)]">
                    <div className="grid min-w-0 content-start gap-4 overflow-y-auto overflow-x-hidden pr-1">
                      <section className="grid min-w-0 gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-on-surface">Cấu hình</h3>
                          <p className="text-xs text-on-surface-variant">Thiết lập khoảng thời gian vận hành chỉ dùng cho xuất tệp.</p>
                        </div>
                        <label className="grid min-w-0 gap-1 text-xs font-label-caps text-on-surface-variant">
                          Thời gian bắt đầu
                          <input
                            type="datetime-local"
                            value={exportDraft.from}
                            onChange={(event) => setExportDraft((current) => current ? { ...current, from: event.target.value } : current)}
                            disabled={exportingPdf}
                            className="w-full min-w-0 rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </label>
                        <label className="grid min-w-0 gap-1 text-xs font-label-caps text-on-surface-variant">
                          Thời gian kết thúc
                          <input
                            type="datetime-local"
                            value={exportDraft.to}
                            onChange={(event) => setExportDraft((current) => current ? { ...current, to: event.target.value } : current)}
                            disabled={exportingPdf}
                            className="w-full min-w-0 rounded border border-outline-variant bg-surface-container px-2 py-1.5 font-data-tabular text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </label>
                        <div className="min-w-0 truncate rounded border border-surface-variant bg-surface-container-low px-3 py-2 font-data-tabular text-[11px] text-on-surface-variant">
                          {buildCheckInPdfFileName(season?.seasonCode ?? 'OPS', exportDraft)}
                        </div>
                      </section>
                      <section className="grid min-w-0 gap-3">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-on-surface">Nhóm quầy</h3>
                            <p className="text-xs text-on-surface-variant">Mỗi nhóm được chọn sẽ hiển thị trên một trang PDF.</p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              onClick={() => setExportDraft((current) => current ? { ...current, selectedGroupIds: exportGroups.map((group) => group.id) } : current)}
                              disabled={exportingPdf || exportGroups.length === 0}
                              className="rounded border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Tất cả
                            </button>
                            <button
                              type="button"
                              onClick={() => setExportDraft((current) => current ? { ...current, selectedGroupIds: [] } : current)}
                              disabled={exportingPdf || exportGroups.length === 0}
                              className="rounded border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Bỏ chọn
                            </button>
                          </div>
                        </div>
                        <div className="grid max-h-64 min-w-0 gap-2 overflow-y-auto overflow-x-hidden rounded border border-surface-variant bg-surface-container-low p-2">
                          {exportGroups.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-on-surface-variant">Chọn khoảng thời gian hợp lệ để tải Nhóm quầy.</p>
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
                              <span className="shrink-0 font-data-tabular text-xs text-on-surface-variant">{group.rowCount} dòng</span>
                            </label>
                          ))}
                        </div>
                      </section>
                    </div>
                    <CheckInPdfPreviewPanel
                      error={exportPreviewError}
                      preview={exportPreview}
                      records={flightRecords}
                      seasonCode={season?.seasonCode ?? 'OPS'}
                    />
                  </div>
                  <div className="flex justify-end gap-2 border-t border-surface-variant px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setExportDraft(null)}
                      disabled={exportingPdf}
                      className="rounded border border-outline-variant px-3 py-1.5 text-sm font-semibold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={!canExportPdf}
                      className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className={`material-symbols-outlined text-[18px] ${exportingPdf ? 'animate-spin' : ''}`}>{exportingPdf ? 'sync' : 'download'}</span>
                      {exportingPdf ? 'Đang xuất…' : 'Xuất PDF'}
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
        progress={buildLoadProgress('Đang tải phân bổ quầy...', 20, 'Đang chuẩn bị giao diện')}
        mode="fullscreen"
      />
    }>
      <CheckInAllocationContent />
    </Suspense>
  );
}
