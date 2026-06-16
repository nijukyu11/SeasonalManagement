'use client';

import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  getOperationalSettings,
  getSeasons,
} from '@/lib/remoteStore';
import { buildDefaultDailyDateRange, readDailyDateRangeQuery } from '@/lib/dailySchedule';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  allocateGate,
  buildGateAllocationView,
  buildGatePackedRows,
  buildGateRecordProjection,
  buildGateTimelineTicks,
  formatGateFlightLabel,
  getGateColorToken,
  mergeGateAllocationViewPatch,
  unallocateGate,
  type GateAllocationView,
  type GatePackedItem,
  type GateResourceBar,
  type GateTimelineTicks,
} from '@/lib/gateAllocation';
import {
  getCachedSeasons,
  patchCachedSeasonData,
  publishSeasonWorkspaceChanged,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  applyLocalModificationBatchDelta,
  type LocalSyncMeta,
} from '@/lib/localSeasonStore';
import { queryNativeAllocationWindow, runNativeLocalModificationBatchDeltaResult } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import {
  buildGatePdfPreviewPlan,
  exportGateAllocationPdf,
  renderGatePdfPageElement,
  selectGatePdfPreviewGroups,
  type GatePdfExportRange,
  type GatePdfPreviewPlan,
} from '@/lib/gatePdfExport';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import type { FlightModification, FlightRecord, OperationalSettings, Season } from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteActivity, useCachedRouteSearchParams } from '../components/RouteCacheContext';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import PbbIcon from '../components/PbbIcon';
import SeasonConflictReviewControl from '../components/SeasonConflictReviewControl';
import SyncActionButton from '../components/SyncActionButton';
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncActions,
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
const FULL_BAR_LABEL_WIDTH = 150;
const POOL_LANE_HEIGHT = 32;
const POOL_HEADER_HEIGHT = 36;
const POOL_MIN_HEIGHT = 86;
const POOL_MAX_HEIGHT = 260;
const EMPTY_GATE_EXPORT_GROUP_IDS: string[] = [];
const GATE_COMMIT_DEBOUNCE_MS = 400;

function getAffectedIdsFromGateModifications(mods: FlightModification[]): string[] {
  return Array.from(new Set(mods.map((mod) => mod.legId)));
}

function buildGateWindowKey(fromDateTime: string, toDateTime: string): string {
  return `gate:${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}`;
}

function todayIso(): string {
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

function addDaysToLocalDateTime(value: string, days: number): string {
  const next = new Date(`${value}:00`);
  if (Number.isNaN(next.getTime())) return value;
  next.setDate(next.getDate() + days);
  const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
  return `${date}T${time}`;
}

function buildGateSummary(view: GateAllocationView) {
  return {
    unallocated: view.unallocated.length,
    allocatedFlights: new Set(view.resourceBars.map((bar) => bar.recordId)).size,
    gateBlocks: view.resourceBars.length,
  };
}

function TimelineGridBackground({ ticks }: { ticks: GateTimelineTicks }) {
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
}

function TimelineHeader({ ticks, timelineWidth }: { ticks: GateTimelineTicks; timelineWidth: number }) {
  return (
    <div className="sticky top-0 z-40 flex h-14 border-b border-surface-variant bg-surface-container-lowest">
      <div className="sticky left-0 z-50 flex shrink-0 items-center border-r border-surface-variant bg-surface-container-lowest px-3 text-xs font-semibold text-on-surface" style={{ width: LABEL_COLUMN_WIDTH }}>
        Gate
      </div>
      <div className="relative shrink-0" style={{ width: timelineWidth }}>
        {ticks.macro.map((tick) => (
          <span key={`macro-${tick.at}`} className="absolute top-1 text-[10px] font-semibold text-on-surface-variant" style={{ left: `${tick.leftPercent}%` }}>
            {tick.label}
          </span>
        ))}
        {ticks.major.map((tick) => (
          <span key={`major-${tick.at}`} className="absolute bottom-1 border-l border-outline-variant pl-1 font-data-tabular text-[10px] text-on-surface-variant" style={{ left: `${tick.leftPercent}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function isValidGateExportRange(range: GatePdfExportRange): boolean {
  if (!range.from || !range.to) return false;
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && to > from;
}

function buildGatePdfFileName(seasonCode: string, range: GatePdfExportRange): string {
  const clean = (value: string) => value.replace(/[-:]/g, '').replace('T', '_');
  const safeSeasonCode = seasonCode.replace(/[^A-Za-z0-9_-]+/g, '_') || 'Season';
  return `Gate_Allocation_${safeSeasonCode}_${clean(range.from)}_${clean(range.to)}.pdf`;
}

function GatePdfPreviewPanel({
  error,
  preview,
  records,
  seasonCode,
}: {
  error: string | null;
  preview: GatePdfPreviewPlan | null;
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
        const pageElement = renderGatePdfPageElement({
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
        Select at least one Gate Group to preview the final PDF pages.
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

type GatePointerDragState =
  | {
      kind: 'unallocated';
      recordId: string;
      flightNumber: string;
      pointerId: number;
      offsetX: number;
      offsetY: number;
      currentClientX: number;
      currentClientY: number;
      width: number;
      height: number;
      backgroundColor: string;
      textColor: string;
    }
  | {
      kind: 'allocated';
      recordId: string;
      flightNumber: string;
      gate: number;
      pointerId: number;
      offsetX: number;
      offsetY: number;
      currentClientX: number;
      currentClientY: number;
      width: number;
      height: number;
      backgroundColor: string;
      textColor: string;
    };

type GateExportDraft = GatePdfExportRange & {
  selectedGroupIds: string[];
};

interface GateLocalCommitWorkerRequest {
  type: 'commit';
  requestId: number;
  seasonId: string;
  mods: FlightModification[];
  description: string;
}

type GateLocalCommitWorkerResponse =
  | {
      requestId: number;
      ok: true;
      syncMeta: LocalSyncMeta;
      affectedIds: string[];
    }
  | {
      requestId: number;
      ok: false;
      message: string;
    };

interface PendingGateCommitRequest {
  resolve: (response: Extract<GateLocalCommitWorkerResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
}

type GateCommitPersistenceResult = {
  syncMeta?: LocalSyncMeta;
  affectedIds?: string[];
  source?: 'gate' | 'gate-worker' | 'gate-native';
};

interface PendingAccumulatedGateCommit {
  legIds: string[];
  mods: FlightModification[];
  description: string;
}

function buildGateRecordFromModification(baseRecord: FlightRecord | undefined, mod: FlightModification): FlightRecord | null {
  if (!baseRecord && mod.action === 'added' && mod.addedLeg) return mod.addedLeg as FlightRecord;
  if (!baseRecord) return null;
  if (mod.action === 'deleted') return null;
  if (mod.action === 'added' && mod.addedLeg) return { ...baseRecord, ...mod.addedLeg } as FlightRecord;
  return { ...baseRecord, ...mod } as FlightRecord;
}

function GateAllocationContent() {
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
  const [optimisticGateAllocationView, setOptimisticGateAllocationView] = useState<GateAllocationView | null>(null);
  const [settings, setSettings] = useState<OperationalSettings | null>(null);
  const [fromDateTime, setFromDateTime] = useSessionState('gate:fromDateTime', defaultRange.from);
  const [toDateTime, setToDateTime] = useSessionState('gate:toDateTime', defaultRange.to);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading gate allocation...', 10, 'Preparing workspace')
  );
  const [syncSummarySeeded, setSyncSummarySeeded] = useState(false);
  const [draggedRecordId, setDraggedRecordId] = useState<string | null>(null);
  const [activeDropRowIndex, setActiveDropRowIndex] = useState<number | null>(null);
  const [poolDropActive, setPoolDropActive] = useState(false);
  const [pointerDragState, setPointerDragState] = useState<GatePointerDragState | null>(null);
  const [isGanttFullscreen, setIsGanttFullscreen] = useState(false);
  const [timelinePixelsPerMinute, setTimelinePixelsPerMinute] = useSessionState(
    'gate:timelinePixelsPerMinute',
    DEFAULT_TIMELINE_PIXELS_PER_MINUTE
  );
  const [poolHeight, setPoolHeight] = useSessionState('gate:poolHeight', 150);
  const [poolCollapsed, setPoolCollapsed] = useSessionState('gate:poolCollapsed', false);
  const [exportDraft, setExportDraft] = useState<GateExportDraft | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const ganttScrollRef = useRef<HTMLDivElement | null>(null);
  const ganttFullscreenRef = useRef<HTMLElement | null>(null);
  const latestGateModificationsRef = useRef<Map<string, FlightModification>>(new Map());
  const optimisticGateAllocationViewRef = useRef<GateAllocationView | null>(null);
  const optimisticBaseLocalRevisionRef = useRef<number | null>(null);
  const gateCommitWorkerRef = useRef<Worker | null>(null);
  const gateCommitRequestsRef = useRef(new Map<number, PendingGateCommitRequest>());
  const gateCommitRequestSeqRef = useRef(0);
  const gateCommitAccumulatorRef = useRef<PendingAccumulatedGateCommit | null>(null);
  const gateCommitFlushTimerRef = useRef<number | null>(null);
  const commitQueueRef = useRef(Promise.resolve());
  const currentMutationRef = useRef<Promise<unknown> | null>(null);
  const historySeqRef = useRef(0);
  const appliedRangeQueryRef = useRef<string | null>(null);
  useSessionScrollRestoration('gate:gantt-scroll', ganttScrollRef);
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow, fetchUpdatesNow } = useSeasonSync(syncSeasonId, 'gate');
  const { seedSeasonSyncFromNative } = useSeasonSyncActions();
  const syncing = syncStatus.status === 'syncing' && syncStatus.mode === 'manual';
  const fetchingUpdates = syncStatus.status === 'catching_up' && syncStatus.mode === 'manual';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' || syncStatus.status === 'conflict' ? syncStatus.message : null);
  const fetchProgress = fetchingUpdates ? syncStatus.progress ?? syncStatus.message : syncStatus.message;
  const syncFallbackPendingCount = syncSummarySeeded ? 0 : null;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, 0);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncFallbackPendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncFallbackPendingCount);

  const waitForGateLocalCommit = useCallback(async () => {
    await currentMutationRef.current;
  }, []);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'gate', {
    blocked: pointerDragState !== null,
    reason: pointerDragState ? 'Dragging gate allocation' : undefined,
    beforeSync: waitForGateLocalCommit,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'gate-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
    quiet: true,
    blockingUi: false,
  });

  useEffect(() => {
    if (!syncSeasonId) {
      setSyncSummarySeeded(false);
      return undefined;
    }
    let cancelled = false;
    setSyncSummarySeeded(false);
    void seedSeasonSyncFromNative(syncSeasonId).then(() => {
      if (!cancelled) setSyncSummarySeeded(true);
    }).catch((error) => {
      console.debug('[gate-sync] native summary seed failed', error);
    });
    return () => {
      cancelled = true;
    };
  }, [seedSeasonSyncFromNative, syncSeasonId]);

  const clearOptimisticGateAllocationView = useCallback(() => {
    optimisticGateAllocationViewRef.current = null;
    optimisticBaseLocalRevisionRef.current = null;
    setOptimisticGateAllocationView(null);
  }, []);

  const clearGateCommitAccumulator = useCallback(() => {
    if (gateCommitFlushTimerRef.current != null) {
      window.clearTimeout(gateCommitFlushTimerRef.current);
      gateCommitFlushTimerRef.current = null;
    }
    gateCommitAccumulatorRef.current = null;
  }, []);

  const replaceGateModifications = useCallback((
    nextModifications: Map<string, FlightModification>,
    options: { render?: boolean } = {}
  ) => {
    if (options.render === false) {
      latestGateModificationsRef.current = nextModifications;
      return;
    }
    latestGateModificationsRef.current = new Map(nextModifications);
    setModifications(new Map(nextModifications));
  }, []);

  useEffect(() => {
    if (!requestedRange) {
      appliedRangeQueryRef.current = null;
      return;
    }

    const rangeKey = `${requestedRange.from}|${requestedRange.to}`;
    if (appliedRangeQueryRef.current === rangeKey) return;
    clearOptimisticGateAllocationView();
    setFromDateTime(requestedRange.from);
    setToDateTime(requestedRange.to);
    appliedRangeQueryRef.current = rangeKey;
  }, [clearOptimisticGateAllocationView, requestedRange, setFromDateTime, setToDateTime]);

  const publishWorkspaceChange = useCallback((
    seasonId: string,
    localRevision: number | null,
    source: 'gate' | 'gate-worker' | 'gate-native' | 'gate-sync',
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

  const refreshGateWindow = useCallback(async () => {
    if (!season) return;
    const result = await queryNativeAllocationWindow({
      seasonId: season.id,
      dateFrom: fromDateTime.slice(0, 10),
      dateTo: toDateTime.slice(0, 10),
      resourceType: 'gate',
      limit: 10000,
    });
    if (!result) throw new Error('Native gate allocation query is unavailable.');
    const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
    clearOptimisticGateAllocationView();
    setFlightRecords(result.records);
    replaceGateModifications(nextModifications);
    patchCachedSeasonData(season.id, {
      records: result.records,
      modifications: nextModifications,
    });
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: season.id,
      season,
      records: result.records,
      modifications: nextModifications,
      syncMeta: result.syncMeta,
      windowKey: buildGateWindowKey(fromDateTime, toDateTime),
    });
  }, [clearOptimisticGateAllocationView, fromDateTime, replaceGateModifications, season, toDateTime]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'gate',
    onNativeRefresh: async () => {
      await refreshGateWindow();
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Loading seasons and settings', 15, 'Preparing gate allocation'));
      try {
        const cachedSeasons = getCachedSeasons();
        const [nextSeasons, loadedSettings] = await Promise.all([
          cachedSeasons ? Promise.resolve(cachedSeasons) : getSeasons(),
          getOperationalSettings(),
        ]);
        if (cancelled) return;
        if (!cachedSeasons) setCachedSeasons(nextSeasons);
        setSettings(loadedSettings);
        setSeasons(nextSeasons);
        useSeasonWorkspaceStore.getState().setOperationalSettings(loadedSettings);
        useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);
        if (nextSeasons.length === 0) {
          clearOptimisticGateAllocationView();
          setSeason(null);
          setFlightRecords([]);
          const emptyModifications = new Map<string, FlightModification>();
          latestGateModificationsRef.current = new Map(emptyModifications);
          setModifications(emptyModifications);
          return;
        }
        const targetSeason = nextSeasons.find((item) => item.id === targetSeasonId) ?? nextSeasons[0];
        if (!targetSeasonId || targetSeasonId !== targetSeason.id) {
          router.replace(`/gate?season=${targetSeason.id}`);
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
          resourceType: 'gate',
          limit: 10000,
        });
        if (cancelled) return;
        if (!result) throw new Error('Native gate allocation query is unavailable.');
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setLoadProgress(buildLoadProgress(
          'Preparing Gate Allocation',
          80,
          `${result.records.length} records`
        ));
        setSeason(targetSeason);
        setFlightRecords(result.records);
        replaceGateModifications(nextModifications);
        patchCachedSeasonData(targetSeason.id, {
          records: result.records,
          modifications: nextModifications,
        });
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: targetSeason.id,
          season: targetSeason,
          records: result.records,
          modifications: nextModifications,
          syncMeta: result.syncMeta,
          windowKey: buildGateWindowKey(fromDateTime, toDateTime),
        });
      } catch (err) {
        console.error('Error loading gate allocation', err);
        if (!cancelled) {
          const message = err instanceof Error && err.message ? err.message : 'Could not load gate data from the server.';
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
  }, [clearOptimisticGateAllocationView, fromDateTime, replaceGateModifications, router, showAlert, targetSeasonId, toDateTime]);

  const allocationResult = useMemo(() => {
    if (!settings) return { view: null, error: null };
    try {
      return {
        view: buildGateAllocationView({
          records: flightRecords,
          modifications,
          settings,
          from: fromDateTime,
          to: toDateTime,
          groupByGateGroup: true,
          pixelsPerMinute: timelinePixelsPerMinute,
        }),
        error: null,
      };
    } catch (err) {
      return { view: null, error: (err as Error).message };
    }
  }, [flightRecords, fromDateTime, modifications, settings, timelinePixelsPerMinute, toDateTime]);
  const displayGateAllocationView = optimisticGateAllocationView ?? allocationResult.view;

  useEffect(() => {
    if (!optimisticGateAllocationViewRef.current) return;
    const baseRevision = optimisticBaseLocalRevisionRef.current;
    const currentRevision = syncStatus.localRevision;
    if (baseRevision == null || currentRevision == null || currentRevision > baseRevision) {
      clearOptimisticGateAllocationView();
    }
  }, [allocationResult.view, clearOptimisticGateAllocationView, syncStatus.localRevision]);

  const timeline = useMemo(() => {
    try {
      return { ticks: buildGateTimelineTicks(fromDateTime, toDateTime), width: buildTimelineWidth(fromDateTime, toDateTime, timelinePixelsPerMinute), error: null };
    } catch (err) {
      return { ticks: null, width: 720, error: (err as Error).message };
    }
  }, [fromDateTime, timelinePixelsPerMinute, toDateTime]);
  const exportDraftFrom = exportDraft?.from ?? null;
  const exportDraftTo = exportDraft?.to ?? null;
  const exportSelectedGroupIds = exportDraft?.selectedGroupIds ?? EMPTY_GATE_EXPORT_GROUP_IDS;
  const deferredExportSelectedGroupIds = useDeferredValue(exportSelectedGroupIds);
  const exportBasePreviewResult = useMemo(() => {
    if (!exportDraftFrom || !exportDraftTo || !settings) return { preview: null, error: null };
    try {
      return {
        preview: buildGatePdfPreviewPlan({
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
      ? selectGatePdfPreviewGroups(exportBasePreviewResult.preview, deferredExportSelectedGroupIds)
      : null
  ), [deferredExportSelectedGroupIds, exportBasePreviewResult.preview]);
  const exportPreviewError = exportBasePreviewResult.error;
  const exportGroups = exportBasePreviewResult.preview?.availableGroups ?? [];
  const canExportPdf = Boolean(
    exportDraft &&
      exportSelectedGroupIds.length > 0 &&
      !exportPreviewError &&
      isValidGateExportRange(exportDraft) &&
      !exportingPdf
  );
  const view = displayGateAllocationView;
  const summary = view ? buildGateSummary(view) : { unallocated: 0, allocatedFlights: 0, gateBlocks: 0 };
  const packedUnallocated = useMemo(() => {
    if (!view) return { laneCount: 0, items: [] };
    try {
      return buildGatePackedRows(view.unallocated, fromDateTime, toDateTime);
    } catch {
      return { laneCount: 0, items: [] };
    }
  }, [fromDateTime, toDateTime, view]);
  const poolBodyHeight = poolCollapsed ? 0 : Math.max(0, poolHeight - POOL_HEADER_HEIGHT - 8);
  const packedPoolHeight = Math.max(POOL_LANE_HEIGHT, packedUnallocated.laneCount * POOL_LANE_HEIGHT);
  const recordById = useMemo(() => new Map(flightRecords.map((record) => [record.id, record])), [flightRecords]);
  const getEffectiveGateRecord = useCallback((recordId: string): FlightRecord | null => {
    const baseRecord = recordById.get(recordId);
    const mod = latestGateModificationsRef.current.get(recordId);
    return mod ? buildGateRecordFromModification(baseRecord, mod) : baseRecord ?? null;
  }, [recordById]);
  const resourceBarsByRow = useMemo(() => {
    const rows = new Map<number, GateResourceBar[]>();
    for (const bar of view?.resourceBars ?? []) rows.set(bar.gateIndex, [...(rows.get(bar.gateIndex) ?? []), bar]);
    return rows;
  }, [view]);
  const rowLaneCounts = useMemo(() => {
    const lanes = new Map<number, number>();
    for (const bar of view?.resourceBars ?? []) lanes.set(bar.gateIndex, Math.max(lanes.get(bar.gateIndex) ?? 1, bar.stackLaneCount));
    return lanes;
  }, [view]);

  const promoteLatestGateModificationsForView = useCallback(() => {
    const latestModifications = new Map(latestGateModificationsRef.current);
    latestGateModificationsRef.current = new Map(latestModifications);
    setModifications(latestModifications);
  }, []);

  const applyOptimisticGateModification = useCallback((mergedMod: FlightModification) => {
    const workingModifications = latestGateModificationsRef.current;
    workingModifications.set(mergedMod.legId, mergedMod);
    if (!optimisticGateAllocationViewRef.current) {
      optimisticBaseLocalRevisionRef.current = syncStatus.localRevision;
    }

    const baseView = optimisticGateAllocationViewRef.current ?? allocationResult.view;
    const baseRecord = recordById.get(mergedMod.legId);
    const projectedRecord = buildGateRecordFromModification(baseRecord, mergedMod);
    if (baseView) {
      const projection = buildGateRecordProjection({
        recordId: mergedMod.legId,
        record: projectedRecord,
        from: fromDateTime,
        to: toDateTime,
        roster: baseView.roster,
        pixelsPerMinute: timelinePixelsPerMinute,
      });
      const patchedView = mergeGateAllocationViewPatch(baseView, projection);
      optimisticGateAllocationViewRef.current = patchedView;
      setOptimisticGateAllocationView(patchedView);
    }
  }, [allocationResult.view, fromDateTime, recordById, syncStatus.localRevision, timelinePixelsPerMinute, toDateTime]);

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

  const commitGateModificationsOnMainThread = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<GateCommitPersistenceResult> => {
    if (mods.length === 0) return {};
    const affectedIds = getAffectedIdsFromGateModifications(mods);
    return enqueueLocalMutation(async () => {
      const timestamp = Date.now();
      const syncMeta = await applyLocalModificationBatchDelta(seasonId, mods, {
        id: `LOCAL_GATE_${timestamp}_${++historySeqRef.current}`,
        timestamp,
        description,
      });
      return {
        syncMeta,
        affectedIds,
        source: 'gate',
      };
    });
  }, [enqueueLocalMutation]);

  const commitGateModificationsNative = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<GateCommitPersistenceResult | null> => {
    if (mods.length === 0) return {};
    return enqueueLocalMutation(async () => {
      const timestamp = Date.now();
      const nativeResult = await runNativeLocalModificationBatchDeltaResult(seasonId, mods, {
        id: `LOCAL_GATE_${timestamp}_${++historySeqRef.current}`,
        timestamp,
        description,
      });
      if (!nativeResult) return null;
      return {
        syncMeta: nativeResult.syncMeta,
        affectedIds: nativeResult.affectedIds,
        source: 'gate-native',
      };
    });
  }, [enqueueLocalMutation]);

  const getGateCommitWorker = useCallback((): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (gateCommitWorkerRef.current) return gateCommitWorkerRef.current;
    try {
      const worker = new Worker(new URL('./gateLocalCommitWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<GateLocalCommitWorkerResponse>) => {
        const pending = gateCommitRequestsRef.current.get(event.data.requestId);
        if (!pending) return;
        gateCommitRequestsRef.current.delete(event.data.requestId);
        if (event.data.ok) {
          pending.resolve(event.data);
        } else {
          pending.reject(new Error(event.data.message));
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || 'Gate local commit worker failed.');
        for (const pending of gateCommitRequestsRef.current.values()) pending.reject(error);
        gateCommitRequestsRef.current.clear();
        gateCommitWorkerRef.current?.terminate();
        gateCommitWorkerRef.current = null;
      };
      gateCommitWorkerRef.current = worker;
      return worker;
    } catch {
      gateCommitWorkerRef.current = null;
      return null;
    }
  }, []);

  const commitGateModificationsInWorker = useCallback((
    worker: Worker,
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<Extract<GateLocalCommitWorkerResponse, { ok: true }>> => {
    const requestId = ++gateCommitRequestSeqRef.current;
    const requestPromise = new Promise<Extract<GateLocalCommitWorkerResponse, { ok: true }>>((resolve, reject) => {
      gateCommitRequestsRef.current.set(requestId, { resolve, reject });
    });
    const request: GateLocalCommitWorkerRequest = {
      type: 'commit',
      requestId,
      seasonId,
      mods,
      description,
    };
    worker.postMessage(request);
    return requestPromise;
  }, []);

  const persistGateModifications = useCallback(async (
    seasonId: string,
    mods: FlightModification[],
    description: string
  ): Promise<GateCommitPersistenceResult> => {
    if (mods.length === 0) return {};
    const nativeResult = await commitGateModificationsNative(seasonId, mods, description);
    if (nativeResult) return nativeResult;
    const worker = getGateCommitWorker();
    if (!worker) {
      return commitGateModificationsOnMainThread(seasonId, mods, description);
    }
    return enqueueLocalMutation(async () => {
      const response = await commitGateModificationsInWorker(worker, seasonId, mods, description);
      return {
        syncMeta: response.syncMeta,
        affectedIds: response.affectedIds ?? getAffectedIdsFromGateModifications(mods),
        source: 'gate-worker',
      };
    });
  }, [commitGateModificationsInWorker, commitGateModificationsNative, commitGateModificationsOnMainThread, enqueueLocalMutation, getGateCommitWorker]);

  const scheduleGateAuditEntry = useCallback((
    entry: PendingAccumulatedGateCommit,
    result: GateCommitPersistenceResult
  ) => {
    const syncMeta = result.syncMeta;
    const source = result.source ?? 'gate-worker';
    if (!season || !syncMeta) return;
    const runAudit = () => {
      const auditRecords = entry.legIds.map((legId) => recordById.get(legId)).filter((record): record is FlightRecord => Boolean(record));
      const auditEntry = createFlightActionAuditFromHistory({
        season,
        module: 'gate',
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

  const mergePendingGateCommit = useCallback((
    current: PendingAccumulatedGateCommit | null,
    incoming: PendingAccumulatedGateCommit
  ): PendingAccumulatedGateCommit => {
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
      description: current.description === incoming.description ? current.description : 'Batch gate allocation updates',
    };
  }, []);

  const rollbackAccumulatedGateCommit = useCallback(async (error: unknown) => {
    if (season) {
      clearOptimisticGateAllocationView();
      const result = await queryNativeAllocationWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'gate',
        limit: 10000,
      }).catch(() => null);
      if (result) {
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setFlightRecords(result.records);
        replaceGateModifications(nextModifications);
        patchCachedSeasonData(season.id, {
          records: result.records,
          modifications: nextModifications,
        });
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: season.id,
          season,
          records: result.records,
          modifications: nextModifications,
          syncMeta: result.syncMeta,
          windowKey: buildGateWindowKey(fromDateTime, toDateTime),
        });
      }
    }
    void showAlert({
      title: 'Gate Update Failed',
      message: error instanceof Error ? error.message : String(error),
      tone: 'error',
    });
  }, [clearOptimisticGateAllocationView, fromDateTime, replaceGateModifications, season, showAlert, toDateTime]);

  const flushAccumulatedGateCommit = useCallback(async (entry: PendingAccumulatedGateCommit) => {
    if (!season) return;
    try {
      const result = await persistGateModifications(season.id, entry.mods, entry.description);
      if (!result.syncMeta) return;
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        affectedIds: result.affectedIds ?? entry.legIds,
        modifications: entry.mods,
        syncMeta: result.syncMeta,
      });
      publishWorkspaceChange(
        season.id,
        result.syncMeta.localRevision,
        result.source ?? 'gate-worker',
        result.affectedIds ?? entry.legIds,
        result.syncMeta
      );
      scheduleGateAuditEntry(entry, result);
    } catch (error) {
      await rollbackAccumulatedGateCommit(error);
    }
  }, [persistGateModifications, publishWorkspaceChange, rollbackAccumulatedGateCommit, scheduleGateAuditEntry, season]);

  const scheduleAccumulatedGateCommit = useCallback(({
    legIds,
    mods,
    description,
  }: {
    legIds: string[];
    mods: FlightModification[];
    description: string;
  }): void => {
    if (!season) return;
    const entry = mergePendingGateCommit(gateCommitAccumulatorRef.current, {
      legIds: Array.from(new Set(legIds)),
      mods,
      description,
    });
    gateCommitAccumulatorRef.current = entry;
    if (gateCommitFlushTimerRef.current != null) {
      window.clearTimeout(gateCommitFlushTimerRef.current);
    }
    gateCommitFlushTimerRef.current = window.setTimeout(() => {
      gateCommitFlushTimerRef.current = null;
      const entry = gateCommitAccumulatorRef.current;
      gateCommitAccumulatorRef.current = null;
      if (entry) {
        void flushAccumulatedGateCommit(entry);
      }
    }, GATE_COMMIT_DEBOUNCE_MS);
  }, [flushAccumulatedGateCommit, mergePendingGateCommit, season]);

  const commitGateModificationBatch = useCallback(async (mods: FlightModification[], description: string) => {
    if (!season) throw new Error('No season selected for gate allocation');
    if (mods.length === 0) return;
    for (const mod of mods) {
      const previousOptimisticMod = latestGateModificationsRef.current.get(mod.legId) ?? null;
      const mergedMod = {
        ...previousOptimisticMod,
        ...mod,
        legId: mod.legId,
        action: 'modified' as const,
      };
      applyOptimisticGateModification(mergedMod);
    }
    scheduleAccumulatedGateCommit({
      legIds: Array.from(new Set(mods.map((mod) => mod.legId))),
      mods,
      description,
    });
  }, [applyOptimisticGateModification, scheduleAccumulatedGateCommit, season]);

  const commitGateModification = useCallback(async (mod: FlightModification, description: string) => {
    if (!season) throw new Error('No season selected for gate allocation');
    const previousOptimisticMod = latestGateModificationsRef.current.get(mod.legId) ?? null;
    const mergedMod = {
      ...previousOptimisticMod,
      ...mod,
      legId: mod.legId,
      action: 'modified' as const,
    };
    applyOptimisticGateModification(mergedMod);
    scheduleAccumulatedGateCommit({
      legIds: [mod.legId],
      mods: [mod],
      description,
    });
  }, [applyOptimisticGateModification, scheduleAccumulatedGateCommit, season]);

  const clearGateDragState = useCallback(() => {
    setPointerDragState(null);
    setDraggedRecordId(null);
    setActiveDropRowIndex(null);
    setPoolDropActive(false);
  }, []);

  const resolveGatePointerDrop = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return { kind: 'none' as const };
    const poolTarget = target.closest('[data-gate-pool-drop="true"]');
    if (poolTarget) return { kind: 'pool' as const };
    const rowTarget = target.closest('[data-gate-drop-index]');
    const rowIndexText = rowTarget?.getAttribute('data-gate-drop-index') ?? '';
    const rowIndex = Number(rowIndexText);
    if (Number.isInteger(rowIndex)) return { kind: 'row' as const, rowIndex };
    return { kind: 'none' as const };
  }, []);

  const updateGatePointerPreview = useCallback((clientX: number, clientY: number, drag: GatePointerDragState) => {
    const target = resolveGatePointerDrop(clientX, clientY);
    setActiveDropRowIndex(target.kind === 'row' ? target.rowIndex : null);
    setPoolDropActive(target.kind === 'pool' && drag.kind === 'allocated');
  }, [resolveGatePointerDrop]);

  const handleGatePointerDown = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    source: { kind: 'unallocated'; record: FlightRecord } | { kind: 'allocated'; bar: GateResourceBar }
  ) => {
    if (!isRouteActive || syncing || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-gate-bar-action="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const record = source.kind === 'unallocated' ? source.record : recordById.get(source.bar.recordId);
    const fallback = source.kind === 'allocated'
      ? { airline: source.bar.flightNumber.slice(0, 2), flightNumber: source.bar.flightNumber, rawFlightNumber: source.bar.flightNumber }
      : source.record;
    const color = getGateColorToken(record ?? fallback, settings);
    const drag: GatePointerDragState = source.kind === 'unallocated'
      ? {
          kind: 'unallocated',
          recordId: source.record.id,
          flightNumber: formatGateFlightLabel(source.record),
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          currentClientX: event.clientX,
          currentClientY: event.clientY,
          width: rect.width,
          height: rect.height,
          backgroundColor: color.backgroundColor,
          textColor: color.textColor,
        }
      : {
          kind: 'allocated',
          recordId: source.bar.recordId,
          flightNumber: source.bar.flightNumber,
          gate: source.bar.gate,
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          currentClientX: event.clientX,
          currentClientY: event.clientY,
          width: rect.width,
          height: rect.height,
          backgroundColor: color.backgroundColor,
          textColor: color.textColor,
        };
    setPointerDragState(drag);
    setDraggedRecordId(drag.recordId);
    updateGatePointerPreview(event.clientX, event.clientY, drag);
  }, [isRouteActive, recordById, settings, syncing, updateGatePointerPreview]);

  const handleGatePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isRouteActive) return;
    setPointerDragState((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const next = {
        ...current,
        currentClientX: current.kind === 'allocated' ? current.currentClientX : event.clientX,
        currentClientY: event.clientY,
      } as GatePointerDragState;
      updateGatePointerPreview(event.clientX, event.clientY, next);
      return next;
    });
  }, [isRouteActive, updateGatePointerPreview]);

  const handleGatePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isRouteActive) return;
    const drag = pointerDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = resolveGatePointerDrop(event.clientX, event.clientY);
    clearGateDragState();
    const record = recordById.get(drag.recordId);
    if (!record || syncing) return;
    if (target.kind === 'row') {
      const resource = view?.resourceRows[target.rowIndex];
      if (!resource) return;
      if (drag.kind === 'allocated' && drag.gate === resource.gate) return;
      void commitGateModification(
        allocateGate(record, resource.gate),
        `${drag.kind === 'allocated' ? 'Moved' : 'Allocated'} ${drag.flightNumber} to gate ${resource.label}`
      ).catch((err) => {
        void showAlert({ title: 'Allocate Failed', message: (err as Error).message, tone: 'error' });
      });
      return;
    }
    if (target.kind === 'pool' && drag.kind === 'allocated') {
      void commitGateModification(
        unallocateGate(record),
        `Unallocated gate for ${drag.flightNumber} by pool drop`
      ).catch((err) => {
        void showAlert({ title: 'Unallocate Failed', message: (err as Error).message, tone: 'error' });
      });
    }
  }, [clearGateDragState, commitGateModification, isRouteActive, pointerDragState, recordById, resolveGatePointerDrop, showAlert, syncing, view]);

  const dragOverlay = pointerDragState ? (
    <div
      className="pointer-events-none fixed z-[200] flex items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold"
      style={{
        left: pointerDragState.currentClientX - pointerDragState.offsetX,
        top: pointerDragState.currentClientY - pointerDragState.offsetY,
        width: pointerDragState.width,
        height: pointerDragState.height,
        background: pointerDragState.backgroundColor,
        backgroundColor: pointerDragState.backgroundColor,
        backgroundImage: 'none',
        border: '1px solid #FFFFFF',
        borderRadius: 4,
        boxShadow: 'none',
        color: pointerDragState.textColor,
        opacity: 1,
      }}
    >
      <span className="min-w-0 flex-1 truncate text-center">{pointerDragState.flightNumber}</span>
    </div>
  ) : null;

  useEffect(() => {
    if (!isRouteActive) return undefined;
    const handleFullscreenChange = () => {
      setIsGanttFullscreen(document.fullscreenElement === ganttFullscreenRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [isRouteActive]);

  useEffect(() => {
    const commitRequests = gateCommitRequestsRef.current;
    return () => {
      clearGateCommitAccumulator();
      gateCommitWorkerRef.current?.terminate();
      gateCommitWorkerRef.current = null;
      const error = new Error('Gate local commit worker was closed.');
      for (const pending of commitRequests.values()) pending.reject(error);
      commitRequests.clear();
    };
  }, [clearGateCommitAccumulator]);

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
    promoteLatestGateModificationsForView();
    setTimelinePixelsPerMinute((current) => clampTimelinePixelsPerMinute(current + direction * TIMELINE_ZOOM_STEP));
  }, [promoteLatestGateModificationsForView, setTimelinePixelsPerMinute]);

  const canZoomOut = timelinePixelsPerMinute > MIN_TIMELINE_PIXELS_PER_MINUTE;
  const canZoomIn = timelinePixelsPerMinute < MAX_TIMELINE_PIXELS_PER_MINUTE;

  const handleSync = async () => {
    if (!season || syncing) return;
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Save Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
    }
  };

  const handleFetchUpdates = async () => {
    if (!syncSeasonId || fetchingUpdates || syncing) return;
    try {
      const result = await fetchUpdatesNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Fetch Updates Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Fetch Updates Failed', message: (err as Error).message, tone: 'error' });
    }
  };

  const handleOpenExportDialog = useCallback(() => {
    promoteLatestGateModificationsForView();
    const range = { from: fromDateTime, to: toDateTime };
    let selectedGroupIds: string[] = [];
    if (settings) {
      try {
        selectedGroupIds = buildGatePdfPreviewPlan({
          records: flightRecords,
          modifications: latestGateModificationsRef.current,
          settings,
          range,
        }).availableGroups.map((group) => group.id);
      } catch {
        selectedGroupIds = [];
      }
    }
    setExportDraft({ ...range, selectedGroupIds });
  }, [flightRecords, fromDateTime, promoteLatestGateModificationsForView, settings, toDateTime]);

  const handleExportGatePdf = useCallback(async () => {
    if (!season || !settings || !exportDraft) return;
    if (!isValidGateExportRange(exportDraft)) {
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
        message: 'Select at least one Gate Group before exporting.',
        tone: 'error',
      });
      return;
    }
    setExportingPdf(true);
    try {
      const result = await exportGateAllocationPdf({
        records: flightRecords,
        modifications: latestGateModificationsRef.current,
        settings,
        range: exportDraft,
        selectedGroupIds: exportDraft.selectedGroupIds,
        seasonCode: season.seasonCode,
        fileName: buildGatePdfFileName(season.seasonCode, exportDraft),
      });
      notifyExportCompleted(result.saveResult);
      setExportDraft(null);
    } catch (err) {
      void showAlert({ title: 'Export PDF Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setExportingPdf(false);
    }
  }, [exportDraft, flightRecords, notifyExportCompleted, season, settings, showAlert]);

  const handleUnallocateAllGatesInPeriod = useCallback(async () => {
    const currentView = view;
    if (!currentView) return;
    const visibleRecordIds = Array.from(new Set(currentView.resourceBars.map((bar) => bar.recordId)));
    const mods = visibleRecordIds
      .map((recordId) => getEffectiveGateRecord(recordId))
      .filter((record): record is FlightRecord => record != null)
      .map((record) => unallocateGate(record));
    if (mods.length === 0) return;
    try {
      await commitGateModificationBatch(
        mods,
        `Unallocated all gates from ${formatLocalDateTimeLabel(fromDateTime)} to ${formatLocalDateTimeLabel(toDateTime)}`
      );
    } catch (err) {
      void showAlert({ title: 'Unallocate All Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [commitGateModificationBatch, fromDateTime, getEffectiveGateRecord, showAlert, toDateTime, view]);

  const renderUnallocatedBar = (item: GatePackedItem) => {
    const label = formatGateFlightLabel(item.record);
    const color = getGateColorToken(item.record, settings);
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
        onPointerDown={(event) => handleGatePointerDown(event, { kind: 'unallocated', record: item.record })}
        onPointerMove={handleGatePointerMove}
        onPointerUp={handleGatePointerUp}
        onPointerCancel={clearGateDragState}
        className={`absolute flex h-6 cursor-grab items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold transition-[transform,width,box-shadow,background-color,border-color] duration-200 ease-out active:cursor-grabbing ${draggedRecordId === item.record.id ? 'ring-2 ring-primary/60 ring-offset-1 ring-offset-surface-container-lowest' : ''}`}
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
        title={`${label} | ${formatLocalDateTimeLabel(item.window.start)} - ${formatLocalDateTimeLabel(item.window.end)}`}
      >
        <span className="truncate">{label}</span>
        {fullLabel && (
          <span className="ml-auto shrink-0 pl-2 font-data-tabular font-semibold">
            {formatLocalDateTimeLabel(item.window.start).slice(11)}-{formatLocalDateTimeLabel(item.window.end).slice(11)}
          </span>
        )}
      </button>
    );
  };

  const renderResourceBar = (bar: GateResourceBar) => {
    const left = (bar.leftPercent / 100) * timeline.width;
    const width = Math.max(MIN_BAR_WIDTH, (bar.widthPercent / 100) * timeline.width);
    const record = recordById.get(bar.recordId);
    const color = getGateColorToken(record ?? { airline: bar.flightNumber.slice(0, 2), flightNumber: bar.flightNumber, rawFlightNumber: bar.flightNumber }, settings);
    return (
      <div
        key={bar.id}
        role="button"
        tabIndex={0}
        onPointerDown={(event) => handleGatePointerDown(event, { kind: 'allocated', bar })}
        onPointerMove={handleGatePointerMove}
        onPointerUp={handleGatePointerUp}
        onPointerCancel={clearGateDragState}
        className={`absolute z-10 flex items-center overflow-hidden rounded-[4px] border border-white px-2 text-[11px] font-bold ${syncing ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${draggedRecordId === bar.recordId ? 'ring-2 ring-primary/60 ring-offset-1 ring-offset-surface-container-lowest' : ''}`}
        style={{
          left,
          top: 6 + bar.stackIndex * (BAR_HEIGHT + 4),
          width,
          height: BAR_HEIGHT,
          background: color.backgroundColor,
          backgroundColor: color.backgroundColor,
          backgroundImage: 'none',
          border: '1px solid #FFFFFF',
          borderRadius: 4,
          boxShadow: 'none',
          color: color.textColor,
          opacity: 1,
        }}
        title={`${bar.flightNumber} | Gate ${bar.gate} | ${formatLocalDateTimeLabel(bar.start)} - ${formatLocalDateTimeLabel(bar.end)}`}
      >
        <span className="min-w-0 flex-1 truncate text-center">{bar.flightNumber}</span>
        {record && (
          <button
            type="button"
            data-gate-bar-action="true"
            onClick={(event) => {
              event.stopPropagation();
              void commitGateModification(unallocateGate(record), `Unallocated gate for ${bar.flightNumber}`);
            }}
            disabled={syncing}
            className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white/25 text-[10px] disabled:opacity-50"
            aria-label={`Unallocate ${bar.flightNumber}`}
            title="Unallocate"
          >
            <span className="material-symbols-outlined text-[13px]">close</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface font-sans">
      <div className="flex h-screen min-w-0 flex-1 flex-col bg-surface">
        <header className="z-30 flex flex-none items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Gate Allocation</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">{season ? buildSeasonDisplayLabel(season) : 'No season selected'}</p> 
          </div>
          <div className="flex items-center gap-3">
            <select value={season?.id ?? ''} onChange={(event) => router.push(`/gate?season=${event.target.value}`)} disabled={seasons.length === 0 || syncing} className="min-w-[200px] rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm font-medium text-on-surface">
              {seasons.length === 0 ? <option value="">No seasons</option> : seasons.map((item) => <option key={item.id} value={item.id}>{buildSeasonDisplayLabel(item)}</option>)} 
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
                      promoteLatestGateModificationsForView();
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
                      promoteLatestGateModificationsForView();
                      setToDateTime(event.target.value);
                    }}
                    className="rounded border border-outline-variant bg-surface-container px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <button onClick={() => { promoteLatestGateModificationsForView(); const next = buildDefaultDailyDateRange(todayIso()); setFromDateTime(next.from); setToDateTime(next.to); }} className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface">
                  <span className="material-symbols-outlined text-[16px]">today</span>
                  Today
                </button>
                {[1, 2, 3].map((days) => (
                  <button key={days} onClick={() => { promoteLatestGateModificationsForView(); setToDateTime(addDaysToLocalDateTime(fromDateTime, days)); }} className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant">
                    {days}D
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-container px-3 py-1 text-xs font-bold text-on-primary-container">UNALLOC {summary.unallocated}</span>
                <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">ALLOC {summary.allocatedFlights}</span>
                <span className="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container">BLOCKS {summary.gateBlocks}</span>
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
                  <PbbIcon className="h-[18px] w-[18px]" />
                  Gate Gantt
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUnallocateAllGatesInPeriod();
                    }}
                    disabled={syncing || summary.gateBlocks === 0}
                    className="flex h-7 items-center gap-1.5 rounded border border-outline-variant bg-surface-container-lowest px-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Unallocate all gates in selected period"
                    title="Unallocate all gates in selected period"
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
                    <div className="text-sm font-semibold text-error">Cannot load gate data</div>
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
                ) : !view || !timeline.ticks ? (
                  <div className="flex h-full items-center justify-center text-sm text-error">{allocationResult.error ?? timeline.error ?? 'Gate allocation view is unavailable.'}</div>
                ) : (
                  <div ref={ganttScrollRef} className="h-full overflow-auto">
                    <div className="relative" style={{ minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                      <TimelineHeader ticks={timeline.ticks} timelineWidth={timeline.width} />
                      <div
                        className={`sticky top-14 z-30 border-b border-surface-variant bg-surface-container-lowest shadow-sm transition-colors duration-150 ${poolDropActive ? 'bg-primary-container/20 ring-2 ring-primary/50' : ''}`}
                        style={{ height: poolCollapsed ? POOL_HEADER_HEIGHT : poolHeight }}
                        data-gate-pool-drop="true"
                      >
                        <div className="flex h-9 items-center border-b border-surface-variant bg-surface-container-low">
                          <div className="sticky left-0 z-30 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-low px-3 text-xs font-semibold text-on-surface" style={{ width: LABEL_COLUMN_WIDTH }}>
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
                        {poolCollapsed ? null : view.unallocated.length === 0 ? (
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
                            <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-surface-variant bg-surface-container-lowest px-3 text-xs text-on-surface-variant" style={{ width: LABEL_COLUMN_WIDTH }}>
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
                          <div className="sticky left-0 z-30 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container-low px-3 text-xs font-semibold text-on-surface" style={{ width: LABEL_COLUMN_WIDTH }}>
                            <PbbIcon className="h-[17px] w-[17px]" />
                            Resource Grid
                          </div>
                          <div className="flex h-full shrink-0 items-center px-3 text-xs font-data-tabular text-on-surface-variant" style={{ width: timeline.width }}>
                            {view.resourceRows.length} gates
                          </div>
                        </div>
                        {view.resourceSections.map((section) => {
                          const resources = view.resourceRows.slice(section.startIndex, section.endIndex + 1);
                          return (
                            <div key={section.id}>
                              <div className="flex h-8 items-center border-b border-surface-variant/70 bg-surface-container text-xs font-semibold text-on-surface-variant" style={{ minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                                <div className="sticky left-0 z-20 flex h-full shrink-0 items-center gap-2 border-r border-surface-variant bg-surface-container px-3" style={{ width: LABEL_COLUMN_WIDTH }}>
                                  <span className="material-symbols-outlined text-[16px]">hub</span>
                                  <span className="min-w-0 truncate">{section.name}</span>
                                </div>
                              </div>
                              {resources.map((resource, offset) => {
                                const rowIndex = section.startIndex + offset;
                                const bars = resourceBarsByRow.get(rowIndex) ?? [];
                                const laneCount = rowLaneCounts.get(rowIndex) ?? 1;
                                const rowHeight = Math.max(RESOURCE_ROW_HEIGHT, 12 + laneCount * (BAR_HEIGHT + 4));
                                return (
                                  <div key={`${resource.clusterId}-${resource.label}-${rowIndex}`} className={`flex border-b border-surface-variant/70 ${rowIndex % 2 === 0 ? 'bg-surface-container-lowest' : 'bg-surface-container-low/60'}`} style={{ height: rowHeight, minWidth: LABEL_COLUMN_WIDTH + timeline.width }}>
                                    <div className="sticky left-0 z-20 flex shrink-0 items-center justify-between gap-2 border-r border-surface-variant px-3 font-data-tabular text-xs font-semibold text-on-surface" style={{ width: LABEL_COLUMN_WIDTH }}>
                                      <span className="min-w-0 truncate">{resource.label}</span>
                                    </div>
                                    <div
                                      className={`relative shrink-0 transition-colors ${activeDropRowIndex === rowIndex ? 'bg-primary-container/20 ring-2 ring-primary/40' : ''}`}
                                      style={{ width: timeline.width }}
                                      data-gate-drop-index={rowIndex}
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
          </section>

          {exportDraft && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !exportingPdf && setExportDraft(null)}>
              <form
                className="flex max-h-[calc(100vh-32px)] w-[min(1180px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleExportGatePdf();
                }}
              >
                <div className="flex items-center justify-between border-b border-surface-variant px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-on-surface">Export PDF</h2>
                    <p className="text-xs text-on-surface-variant">A4 landscape, one gate group per page</p>
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
                        <p className="text-xs text-on-surface-variant">Set an export-only gate allocation window.</p>
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
                        {season ? buildGatePdfFileName(season.seasonCode, exportDraft) : 'Gate_Allocation_Season.pdf'}
                      </div>
                    </section>
                    <section className="grid min-w-0 gap-3">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-on-surface">Gate Groups</h3>
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
                          <p className="px-1 py-2 text-xs text-on-surface-variant">Choose a valid timeframe to load Gate Groups.</p>
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
                            <span className="shrink-0 font-data-tabular text-xs text-on-surface-variant">{group.rowCount} gates</span>
                          </label>
                        ))}
                      </div>
                    </section>
                  </div>
                  <GatePdfPreviewPanel
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
        </main>
      </div>
      {dragOverlay}
      {dialogNode}
    </div>
  );
}

export default function GateAllocationPage() {
  return (
    <Suspense fallback={
      <LoadingStatusPanel
        progress={buildLoadProgress('Loading gate allocation...', 20, 'Preparing route')}
        mode="fullscreen"
      />
    }>
      <GateAllocationContent />
    </Suspense>
  );
}
