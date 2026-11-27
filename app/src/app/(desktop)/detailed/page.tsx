'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  getSeasons,
  loadSeasonWorkspaceWindow,
} from '@/lib/remoteStore';
import { revalidateSeasonWorkspaceWindow } from '@/lib/seasonWorkspaceWindowCoordinator';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  assertNoDuplicateFlightNumbersForEffectiveRecords,
  flightRecordsToLegs,
  linkFlightRecordPairs,
  unlinkFlightRecords,
} from '@/lib/atomicSchedule';
import {
  applyModificationBatch,
  applyModificationsToFlightLegs,
  buildCanonicalAddedFlightRecords,
  compactDraftModifications,
  buildFlightRecordHistoryEntry,
  buildDetailedScheduleQueryWindow,
  buildDetailedTransferPairContext,
  buildDetailedTransferModifications,
  buildOvernightCompanionMap,
  buildSpatialCalendarDateSelection,
  mergeCalendarDateSelections,
  countHistoryEntryLegs,
  formatLinkedFlightTime,
  filterDetailedLegsForView,
  revertFlightRecordHistoryList,
  revertModificationHistoryMap,
  type OvernightCompanionState,
} from '@/lib/detailedScheduleState';
import { activeCanonicalFlightRecordIds } from '@/lib/effectiveSeasonalLegs';
import type { CalendarSelectionMode, NewFlightDateSelection } from '@/lib/detailedScheduleState';
import {
  getCachedSeasons,
  patchCachedSeasonData,
  publishSeasonWorkspaceChanged,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import { filterUiUndoEntriesForSession, trimUiUndoEntries } from '@/lib/uiUndoMemory';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { withScheduleNotificationPayload } from '@/lib/scheduleNotifications';
import { resolveLinkedDeletionTargets } from '@/lib/pairDeletion';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { formatUiError } from '@/lib/uiDisplayText';
import { saveWorkbookAsXlsx } from '@/lib/exportSave';
import type { Season, FlightLeg, FlightModification, ModHistoryEntry, FlightRecord } from '@/lib/types';

interface DetailedScheduleDraftState {
  baseRecords: FlightRecord[];
  baseModifications: Map<string, FlightModification>;
  modifications: FlightModification[];
}

type OvernightCompanion = OvernightCompanionState;
import * as XLSX from 'xlsx';
import { Suspense } from 'react';
import EditModal from './EditModal';
import ConfirmModal from './ConfirmModal';
import NewFlightModal from '../components/NewFlightModal';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteActivity, useCachedRouteSearchParams } from '../components/RouteCacheContext';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import HeaderActionMenu from '../components/HeaderActionMenu';
import SyncActionButton from '../components/SyncActionButton';
import WorkspacePageHeader from '../components/WorkspacePageHeader';
import SeasonalPublishModal from '../components/SeasonalPublishModal';
import SeasonalVersionHistoryModal from '../components/SeasonalVersionHistoryModal';
import {
  isSeasonalPlanningV1Enabled,
  seasonalDraftToFlightRecord,
  type SeasonalDraftChangeInput,
  type SeasonalDraftRecord,
} from '@/lib/seasonalPlanningContract';
import {
  applyModificationsToFlightRecords,
  buildAuthoritativeDraftUndoChanges,
  composeSeasonalDraftUndoChanges,
  createInitialDraftSaveState,
  executeSeasonalPlanningDraftSave,
  isDraftWorkspaceNotFoundError,
  loadFullSeasonalDraftRecords,
  retrySeasonalPlanningDraft,
  type SeasonalDraftRecordsSnapshot,
  type SeasonalDraftSaveState,
} from '@/lib/seasonalPlanningSaveManager';
import { applySeasonalDraftChangesV1, getSeasonalDraftWindowV1 } from '@/lib/remoteStore';
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncGuard,
} from '../components/SeasonSyncProvider';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';
import { runNativeScheduleMutation } from '@/lib/nativeSeasonRepository';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';

const DAYS_OF_WEEK = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

function buildDetailedWindowKey(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  flightNumberFilter?: string | null;
}): string {
  return [
    'detailed',
    input.dateFrom ?? '',
    input.dateTo ?? '',
    input.flightNumberFilter ?? '',
  ].join(':');
}

function getAffectedIdsFromDetailedModifications(mods: FlightModification[]): string[] {
  return Array.from(new Set(mods.map((mod) => mod.legId)));
}

function noOpModificationForRecord(record: FlightRecord): FlightModification {
  return {
    legId: record.id,
    action: 'modified',
    schedule: record.schedule,
    aircraft: record.aircraft,
    route: record.route,
    codeShares: record.codeShares ?? null,
    pax: record.pax ?? null,
    gate: record.gate ?? null,
    stand: record.stand ?? null,
    counter: record.counter ?? null,
    carousel: record.carousel ?? null,
    mct: record.mct ?? null,
    fb: record.fb ?? null,
    lb: record.lb ?? null,
    bhs: record.bhs ?? null,
    ghs: record.ghs ?? null,
  };
}

function DetailedScheduleContent() {
  const router = useRouter();
  const searchParams = useCachedRouteSearchParams();
  const { notifyExportCompleted } = useExportNotifications();
  const isRouteActive = useCachedRouteActivity();
  const { dialogNode, showAlert, showConfirm, showChoice } = useAppDialog();
  const targetSeasonId = searchParams.get('season');
  const targetArrFlight = searchParams.get('arrFlight');
  const targetDepFlight = searchParams.get('depFlight');
  const targetDateFrom = searchParams.get('dateFrom');
  const targetDateTo = searchParams.get('dateTo');
  const hasExplicitDetailedFlightSelection = Boolean(targetArrFlight || targetDepFlight);

  const [season, setSeason] = useState<Season | null>(null);
  const [legs, setLegs] = useState<FlightLeg[]>([]);
  const [allLegs, setAllLegs] = useState<FlightLeg[]>([]);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>([]);
  const [overnightCompanions, setOvernightCompanions] = useState<Map<string, OvernightCompanion>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Đang tải lịch chi tiết...', 10, 'Chuẩn bị lịch')
  );

  // Calendar State
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  
  // Selection State
  const [selectedLegIds, setSelectedLegIds] = useState<Set<string>>(new Set());
  const [canonicalReloadError, setCanonicalReloadError] = useState<string | null>(null);
  const selectedLegs = useMemo(() => legs.filter(l => selectedLegIds.has(l.id)), [legs, selectedLegIds]);
  const singleSelectedLeg = selectedLegs.length === 1 ? selectedLegs[0] : null;
  const linkedLeg = useMemo(() => {
    if (!singleSelectedLeg) return null;
    if (singleSelectedLeg.linkedRecordId) {
      return allLegs.find(l => l.id === singleSelectedLeg.linkedRecordId) ?? null;
    }
    if (singleSelectedLeg.linkId) {
      return allLegs.find(l =>
        l.linkId === singleSelectedLeg.linkId &&
        l.id !== singleSelectedLeg.id &&
        (l.pairAnchorDate ?? l.date) === (singleSelectedLeg.pairAnchorDate ?? singleSelectedLeg.date)
      ) ?? null;
    }
    return null;
  }, [allLegs, singleSelectedLeg]);

  // Edit Flow State
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [proposedMods, setProposedMods] = useState<FlightModification[]>([]);
  const [editMode, setEditMode] = useState<'flight' | 'schedule'>('flight');
  const [isSaving, setIsSaving] = useState(false);
  const [isRestoringDraft, setIsRestoringDraft] = useState(false);
  const isRestoringDraftRef = useRef(false);
  // Undo History State
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [currentMods, setCurrentMods] = useState<Map<string, FlightModification>>(new Map());
  const [draftState, setDraftStateValue] = useState<DetailedScheduleDraftState | null>(null);
  const latestDraftRevisionRef = useRef<number | string>(0);
  const latestDraftEpochRef = useRef<string | null>(null);
  const [draftSaveState, setDraftSaveState] = useState<SeasonalDraftSaveState>(() => createInitialDraftSaveState(0));

  useEffect(() => {
    if (!isSeasonalPlanningV1Enabled()) return;
    if (!draftSaveState.hasUnconfirmedChanges && draftSaveState.status !== 'saving') return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [draftSaveState.hasUnconfirmedChanges, draftSaveState.status]);
  const latestDraftStateRef = useRef<{
    value: DetailedScheduleDraftState | null;
    revision: number;
    hasDraftChanges: boolean;
  }>({ value: null, revision: 0, hasDraftChanges: false });
  const localEditGenerationRef = useRef(0);

  const setDraftState = useCallback((nextDraft: DetailedScheduleDraftState | null) => {
    const latest = latestDraftStateRef.current;
    if (latest.value !== nextDraft) {
      latestDraftStateRef.current = {
        value: nextDraft,
        revision: latest.revision + 1,
        hasDraftChanges: (nextDraft?.modifications.length ?? 0) > 0,
      };
    }
    setDraftStateValue(nextDraft);
  }, []);
  const [isUndoOpen, setIsUndoOpen] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isNewFlightOpen, setIsNewFlightOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null); // for pre-filling Add Flight date
  const detailedCommitSeqRef = useRef(0);
  const loadedWindowKeyRef = useRef<string | null>(null);
  const fetchServerDataRequestRef = useRef(0);
  const latestRouteWindowRef = useRef<{ seasonId: string | null; windowKey: string }>({
    seasonId: null,
    windowKey: '',
  });
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    lastLocalChangeAt: null,
  });
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow } = useSeasonSync(syncSeasonId, 'detailed');
  const [fetchingServerData, setFetchingServerData] = useState(false);
  const syncInProgress = syncStatus.status === 'syncing';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' ? syncStatus.message : null);
  const fetchProgress = fetchingServerData ? 'Đang tải dữ liệu từ máy chủ' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const draftChangeCount = draftState?.modifications.length ?? 0;
  const hasDraftChanges = draftChangeCount > 0;
  const isMutationBlocked =
    syncInProgress ||
    isSaving ||
    isUndoing ||
    isRestoringDraft ||
    (isSeasonalPlanningV1Enabled() && (
      draftSaveState.status === 'saving' ||
      draftSaveState.hasUnconfirmedChanges ||
      Boolean(canonicalReloadError)
    ));
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [historyDraftTokens, setHistoryDraftTokens] = useState<{ revision: string | number; epoch: string | null }>({ revision: 0, epoch: null });
  const currentDetailedWindow = buildDetailedScheduleQueryWindow({
    dateFrom: fromDate || targetDateFrom || null,
    dateTo: toDate || targetDateTo || null,
    targetArrFlight,
    targetDepFlight,
  });
  const currentDetailedWindowKey = buildDetailedWindowKey(currentDetailedWindow);
  useEffect(() => {
    latestRouteWindowRef.current = {
      seasonId: season?.id ?? null,
      windowKey: currentDetailedWindowKey,
    };
  }, [currentDetailedWindowKey, season?.id]);

  // Sweep Selection State
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<string | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<CalendarSelectionMode>('replace');
  const suppressNextCellClickRef = useRef(false);

  // Clipboard State (for Ctrl+C / Ctrl+V)
  const [copiedLeg, setCopiedLeg] = useState<FlightLeg | null>(null);
  // Track selected dates for paste target (sweep or manual pick)
  const [sweepSelectedDates, setSweepSelectedDates] = useState<string[]>([]);
  // Anchor for Shift+click range selection
  const [dateAnchor, setDateAnchor] = useState<string | null>(null);
  const calendarScrollRef = useRef<HTMLDivElement | null>(null);
  useSessionScrollRestoration('detailed:calendar-scroll', calendarScrollRef);

  const newFlightDates = useMemo(() => {
    if (sweepSelectedDates.length > 0) return sweepSelectedDates;
    return selectedDate ? [selectedDate] : [];
  }, [selectedDate, sweepSelectedDates]);

  const newFlightDateSelection = useMemo<NewFlightDateSelection | undefined>(() => (
    newFlightDates.length > 0 ? { kind: 'dates', dates: newFlightDates } : undefined
  ), [newFlightDates]);

  const newFlightDateLabel = useMemo(() => {
    if (newFlightDates.length === 0) return '';
    if (newFlightDates.length === 1) return newFlightDates[0];
    return `${newFlightDates.length} ngày`;
  }, [newFlightDates]);

  useEffect(() => {
    if (typeof window === 'undefined' || !fromDate) return;
    sessionStorage.setItem('detailed_from', fromDate);
  }, [fromDate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !toDate) return;
    sessionStorage.setItem('detailed_to', toDate);
  }, [toDate]);

  const refreshDetailedState = useCallback((
    nextRecords: FlightRecord[],
    nextMods: Map<string, FlightModification>,
    options: { preserveSelection?: boolean } = {}
  ) => {
    const baseAllLegs = flightRecordsToLegs(nextRecords);
    const finalAllLegs = applyModificationsToFlightLegs(baseAllLegs, nextMods);
    const finalLegs = filterDetailedLegsForView(
      finalAllLegs,
      targetArrFlight,
      targetDepFlight,
      targetDateFrom || fromDate || null,
      targetDateTo || toDate || null
    );
    setAllLegs(finalAllLegs);
    setLegs(finalLegs);
    const companionMap = buildOvernightCompanionMap(finalLegs, finalAllLegs);
    const visibleStart = fromDate || targetDateFrom || null;
    const visibleEnd = toDate || targetDateTo || null;
    const filteredCompanionMap = new Map<string, OvernightCompanionState>();
    for (const [key, comp] of companionMap.entries()) {
      const isOutside = Boolean(
        (visibleStart && comp.date < visibleStart) ||
        (visibleEnd && comp.date > visibleEnd)
      );
      if (targetArrFlight || targetDepFlight || isOutside) {
        filteredCompanionMap.set(key, comp);
      }
    }
    setOvernightCompanions(filteredCompanionMap);
    setSelectedLegIds((prev) => {
      if (!options.preserveSelection) return new Set();
      const visibleIds = new Set(finalLegs.map((leg) => leg.id));
      return new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
    });
  }, [
    fromDate,
    setAllLegs,
    setLegs,
    setOvernightCompanions,
    setSelectedLegIds,
    targetArrFlight,
    targetDateFrom,
    targetDateTo,
    targetDepFlight,
    toDate,
  ]);
  const refreshDetailedStateRef = useRef(refreshDetailedState);
  useEffect(() => {
    refreshDetailedStateRef.current = refreshDetailedState;
  }, [refreshDetailedState]);

  const publishDetailedWorkspaceChange = useCallback((
    seasonId: string,
    localRevision: number | null | undefined,
    affectedIds: string[] = [],
    syncMeta: LocalSyncMeta | null = null
  ) => {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision: localRevision ?? null,
      source: 'detailed',
      affectedIds,
      syncMeta,
    });
  }, []);

  const syncCanonicalDraftAfterCommit = useCallback(async (
    targetSeason: NonNullable<typeof season>,
    committedRevision: string | number,
    affectedIds: string[],
    resetRowDates = false
  ): Promise<boolean> => {
    try {
      const draftData = await loadFullSeasonalDraftRecords(targetSeason.id, getSeasonalDraftWindowV1);
      latestDraftRevisionRef.current = draftData.revision;
      latestDraftEpochRef.current = draftData.epoch;
      setHistoryDraftTokens({ revision: draftData.revision, epoch: draftData.epoch });
      setFlightRecords(draftData.records);
      setCurrentMods(new Map());
      patchCachedSeasonData(targetSeason.id, {
        records: draftData.records,
        modifications: new Map(),
      });
      const syncMeta: LocalSyncMeta = {
        seasonId: targetSeason.id,
        localRevision: Number(draftData.revision) || 0,
        pendingCount: 0,
        lastLocalChangeAt: Date.now(),
        baseServerVersion: targetSeason.dataVersion ?? 0,
        syncStatus: 'synced',
      };
      setSyncSummary({ pendingCount: 0, lastLocalChangeAt: syncMeta.lastLocalChangeAt });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: targetSeason.id,
        season: targetSeason,
        windowKey: loadedWindowKeyRef.current ?? undefined,
        records: draftData.records,
        modifications: new Map(),
        syncMeta,
      });
      refreshDetailedState(draftData.records, new Map(), { preserveSelection: true });
      publishDetailedWorkspaceChange(targetSeason.id, syncMeta.localRevision, affectedIds, syncMeta);
      setDraftSaveState((prev) => ({ ...createInitialDraftSaveState(draftData.revision), status: 'saved', lastSavedAt: prev.lastSavedAt }));
      setCanonicalReloadError(null);
      return true;
    } catch (reloadErr) {
      const errorMsg = formatUiError(reloadErr, 'Không thể nạp lại dữ liệu bản nháp sau khi lưu.');
      setCanonicalReloadError(errorMsg);
      const failedSyncMeta: LocalSyncMeta = {
        seasonId: targetSeason.id,
        localRevision: Number(committedRevision) || 0,
        pendingCount: 0,
        lastLocalChangeAt: Date.now(),
        baseServerVersion: targetSeason.dataVersion ?? 0,
        syncStatus: 'failed',
      };
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: targetSeason.id,
        affectedIds,
        syncMeta: failedSyncMeta,
      });
      publishDetailedWorkspaceChange(targetSeason.id, failedSyncMeta.localRevision, affectedIds, failedSyncMeta);
      setDraftSaveState((prev) => ({
        ...prev,
        status: 'saved',
        pendingRequest: null,
        hasUnconfirmedChanges: false,
        error: errorMsg,
      }));
      return false;
    }
  }, [publishDetailedWorkspaceChange, refreshDetailedState, setCurrentMods, setDraftSaveState, setFlightRecords, setSyncSummary]);

  const handleRetryDraftSave = useCallback(async () => {
    if (!season) return;
    if (draftSaveState.status === 'saving') return;
    if (canonicalReloadError) {
      setDraftSaveState((prev) => ({ ...prev, status: 'saving', error: null }));
      await syncCanonicalDraftAfterCommit(season, latestDraftRevisionRef.current, []);
      return;
    }
    if (draftSaveState.status !== 'error') return;
    setDraftSaveState((prev) => ({ ...prev, status: 'saving', error: null }));
    const saveResult = await retrySeasonalPlanningDraft(draftSaveState);
    if (saveResult.result) {
      setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
      if (saveResult.result.status === 'saved' && saveResult.result.receipt) {
        latestDraftRevisionRef.current = saveResult.result.receipt.revision;
        await syncCanonicalDraftAfterCommit(season, saveResult.result.receipt.revision, []);
      }
    }
  }, [canonicalReloadError, draftSaveState, season, setDraftSaveState, syncCanonicalDraftAfterCommit]);

  // Planning mode reads season_planning_drafts; the legacy workspace window would show stale operational rows.
  const applyPlanningDraftWindow = useCallback(async (
    activeSeason: NonNullable<typeof season>,
    windowKey: string,
    preserveSelection: boolean
  ) => {
    const startGeneration = localEditGenerationRef.current;
    const startDraftRevision = latestDraftStateRef.current.revision;
    let draftData: SeasonalDraftRecordsSnapshot;
    try {
      draftData = await loadFullSeasonalDraftRecords(activeSeason.id, getSeasonalDraftWindowV1);
    } catch (err) {
      if (isDraftWorkspaceNotFoundError(err)) return null;
      throw err;
    }
    const route = latestRouteWindowRef.current;
    // Route moved on while loading: drop this result without falling back to the legacy window.
    if (route.seasonId !== activeSeason.id || route.windowKey !== windowKey) return draftData.records;
    // User started editing or draft revision changed while loading: drop this result to protect user edits.
    if (
      localEditGenerationRef.current !== startGeneration ||
      latestDraftStateRef.current.revision !== startDraftRevision ||
      latestDraftStateRef.current.hasDraftChanges ||
      latestDraftStateRef.current.value !== null
    ) {
      return draftData.records;
    }
    latestDraftRevisionRef.current = draftData.revision;
    latestDraftEpochRef.current = draftData.epoch;
    setDraftSaveState(createInitialDraftSaveState(draftData.revision));
    setCanonicalReloadError(null);
    setHistoryDraftTokens({ revision: draftData.revision, epoch: draftData.epoch });
    patchCachedSeasonData(activeSeason.id, { records: draftData.records, modifications: new Map() });
    const mods = new Map<string, FlightModification>();
    const syncMeta: LocalSyncMeta = {
      seasonId: activeSeason.id,
      localRevision: Number(draftData.revision) || 0,
      pendingCount: 0,
      lastLocalChangeAt: Date.now(),
      baseServerVersion: activeSeason.dataVersion ?? 0,
      syncStatus: 'synced',
    };
    loadedWindowKeyRef.current = windowKey;
    setFlightRecords(draftData.records);
    setCurrentMods(mods);
    setDraftState(null);
    setSyncSummary({ pendingCount: 0, lastLocalChangeAt: syncMeta.lastLocalChangeAt });
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: activeSeason.id,
      season: activeSeason,
      records: draftData.records,
      modifications: mods,
      syncMeta,
      windowKey,
    });
    publishSeasonWorkspaceChanged({
      seasonId: activeSeason.id,
      localRevision: syncMeta.localRevision,
      source: 'server-window',
      syncMeta,
    });
    refreshDetailedState(draftData.records, mods, { preserveSelection });
    return draftData.records;
  }, [refreshDetailedState, setCurrentMods, setDraftSaveState, setDraftState, setFlightRecords, setSyncSummary]);

  const refreshDetailedWindow = useCallback(async (options: { preserveSelection?: boolean; revalidate?: boolean } = {}) => {
    if (!season?.id) return null;
    if (hasDraftChanges) return null;
    const queryWindow = buildDetailedScheduleQueryWindow({
      dateFrom: targetDateFrom || fromDate || null,
      dateTo: targetDateTo || toDate || null,
      targetArrFlight,
      targetDepFlight,
    });
    const windowKey = buildDetailedWindowKey(queryWindow);
    if (isSeasonalPlanningV1Enabled()) {
      const records = await applyPlanningDraftWindow(season, windowKey, options.preserveSelection ?? true);
      if (records) return { records };
    }
    if (options.revalidate) {
      await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: queryWindow.dateFrom,
        dateTo: queryWindow.dateTo,
        resourceType: 'schedule',
        limit: 100000,
      });
    }
    const snapshot = readWorkspaceWindowSnapshot(
      useSeasonWorkspaceStore.getState().workspaces[season.id],
      windowKey
    );
    if (!snapshot?.syncMeta) return null;
    loadedWindowKeyRef.current = windowKey;
    setFlightRecords(snapshot.records);
    setCurrentMods(snapshot.modifications);
    setDraftState(null);
    setSyncSummary({
      pendingCount: snapshot.syncMeta.pendingCount,
      lastLocalChangeAt: snapshot.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, {
      records: snapshot.records,
      modifications: snapshot.modifications,
    });
    refreshDetailedState(snapshot.records, snapshot.modifications, { preserveSelection: options.preserveSelection ?? true });
    if (isSeasonalPlanningV1Enabled()) {
      try {
        const draftWindow = await getSeasonalDraftWindowV1({ seasonId: season.id, pageSize: 1 });
        latestDraftRevisionRef.current = draftWindow.revision;
        latestDraftEpochRef.current = draftWindow.epoch;
      } catch {
        // Draft window RPC fallback
      }
    }
    return snapshot;
  }, [
    applyPlanningDraftWindow,
    fromDate,
    hasDraftChanges,
    refreshDetailedState,
    season,
    setCurrentMods,
    setDraftState,
    setFlightRecords,
    setSyncSummary,
    targetArrFlight,
    targetDateFrom,
    targetDateTo,
    targetDepFlight,
    toDate,
  ]);

  const captureDetailedOptimisticRollbackState = useCallback(() => ({
    records: flightRecords,
    modifications: currentMods,
    history: modHistory,
    summary: syncSummary,
    selectedLegIds: new Set(selectedLegIds),
  }), [currentMods, flightRecords, modHistory, selectedLegIds, syncSummary]);

  const restoreDetailedOptimisticState = useCallback((rollbackState: ReturnType<typeof captureDetailedOptimisticRollbackState>) => {
    setFlightRecords(rollbackState.records);
    setCurrentMods(rollbackState.modifications);
    setModHistory(rollbackState.history);
    setSyncSummary(rollbackState.summary);
    setSelectedLegIds(new Set(rollbackState.selectedLegIds));
    if (season?.id) {
      patchCachedSeasonData(season.id, {
        records: rollbackState.records,
        modifications: rollbackState.modifications,
      });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        records: rollbackState.records,
        modifications: rollbackState.modifications,
      });
    }
    refreshDetailedState(rollbackState.records, rollbackState.modifications, { preserveSelection: true });
  }, [
    refreshDetailedState,
    season,
    setCurrentMods,
    setFlightRecords,
    setModHistory,
    setSelectedLegIds,
    setSyncSummary,
  ]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'detailed',
    onRefresh: async (event) => {
      await refreshDetailedWindow({
        preserveSelection: true,
        revalidate: event.refreshMode === 'revalidate',
      });
    },
  });

  const targetLegsForEdit = useMemo(() => {
    if (editMode === 'flight') return selectedLegs;
    if (targetArrFlight && targetDepFlight) {
      return legs.filter((leg) => (
        (leg.type === 'A' && leg.flightNumber === targetArrFlight) ||
        (leg.type === 'D' && leg.flightNumber === targetDepFlight)
      ));
    }
    if (singleSelectedLeg) {
      return legs.filter(l => l.flightNumber === singleSelectedLeg.flightNumber && l.type === singleSelectedLeg.type);
    }
    return legs;
  }, [editMode, selectedLegs, targetArrFlight, targetDepFlight, legs, singleSelectedLeg]);

  const handleEditFlight = () => {
    setEditMode('flight');
    setIsEditModalOpen(true);
  };

  const handleEditSchedule = () => {
    setEditMode('schedule');
    setIsEditModalOpen(true);
  };

  const shiftDate = (iso: string, offsetDays: number) => {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().split('T')[0];
  };

  const timeToMinutes = (time: string) => {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
  };


  interface DetailedLinkCandidate {
    key: string;
    label: string;
    linkType: 'overnight' | 'sameday';
    arrIds: string[];
    depIds: string[];
  }

interface LinkCandidateItemProps {
  candidate: DetailedLinkCandidate;
  onApply: (candidate: DetailedLinkCandidate) => void;
}

function LinkCandidateItem({ candidate, onApply }: LinkCandidateItemProps) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-surface-variant hover:bg-primary-container/10 transition-colors">
      <div className="min-w-0">
        <div className="font-data-tabular text-sm font-semibold text-primary truncate">{candidate.label}</div>
        <div className="text-xs text-on-surface-variant">
          {candidate.linkType === 'overnight' ? 'Qua đêm +1' : 'Trong ngày'} · {candidate.arrIds.length} cặp
        </div>
      </div>
      <button
        type="button"
        onClick={() => onApply(candidate)}
        className="shrink-0 px-3 py-1.5 rounded bg-tertiary-container text-on-tertiary-container text-xs font-semibold hover:bg-tertiary-container/80 transition-colors"
      >
        Liên kết
      </button>
    </div>
  );
}

  const linkCandidates = useMemo((): DetailedLinkCandidate[] => {
    if (selectedLegs.length === 0) return [];
    if (selectedLegs.some((leg) => leg.linkType)) return [];

    const selectedType = selectedLegs[0].type;
    if (selectedLegs.some((leg) => leg.type !== selectedType)) return [];

    const selectedDates = new Set(selectedLegs.map((leg) => leg.date));
    if (selectedDates.size !== selectedLegs.length) return [];

    const oppositeType = selectedType === 'A' ? 'D' : 'A';
    const groups = new Map<string, { sample: FlightLeg; linkType: 'overnight' | 'sameday'; byDate: Map<string, FlightLeg> }>();

    for (const candidate of allLegs) {
      if (selectedLegIds.has(candidate.id)) continue;
      if (candidate.type !== oppositeType) continue;
      if (candidate.linkType) continue;
      if (candidate.airline !== selectedLegs[0].airline) continue;
      if (candidate.aircraft !== selectedLegs[0].aircraft) continue;

      const selectedSample = selectedLegs[0];
      const arrTime = selectedType === 'A' ? selectedSample.schedule : candidate.schedule;
      const depTime = selectedType === 'A' ? candidate.schedule : selectedSample.schedule;
      const linkType = timeToMinutes(depTime) < timeToMinutes(arrTime) ? 'overnight' as const : 'sameday' as const;
      const key = `${candidate.airline}|${candidate.type}|${candidate.flightNumber}|${candidate.route}|${candidate.schedule}|${candidate.aircraft}|${linkType}`;
      const group = groups.get(key) ?? { sample: candidate, linkType, byDate: new Map<string, FlightLeg>() };
      group.byDate.set(candidate.date, candidate);
      groups.set(key, group);
    }

    const result: DetailedLinkCandidate[] = [];
    for (const [key, group] of groups) {
      const matched: FlightLeg[] = [];
      for (const selected of selectedLegs) {
        const targetDate = group.linkType === 'overnight'
          ? selectedType === 'A' ? shiftDate(selected.date, 1) : shiftDate(selected.date, -1)
          : selected.date;
        const counterpart = group.byDate.get(targetDate);
        if (counterpart) matched.push(counterpart);
      }
      if (matched.length !== selectedLegs.length) continue;

      result.push({
        key,
        label: `${group.sample.flightNumber} ${group.sample.route} ${group.sample.schedule}`,
        linkType: group.linkType,
        arrIds: selectedType === 'A' ? selectedLegs.map((leg) => leg.id) : matched.map((leg) => leg.id),
        depIds: selectedType === 'D' ? selectedLegs.map((leg) => leg.id) : matched.map((leg) => leg.id),
      });
    }

    return result;
  }, [allLegs, selectedLegIds, selectedLegs]);

  const handleUnlinkSelected = useCallback(async () => {
    if (!season || isMutationBlocked) return;
    const ids = selectedLegs.filter((leg) => leg.linkType || leg.linkedRecordId).map((leg) => leg.id);
    if (ids.length === 0) return;
    const shouldUnlink = await showConfirm({
      title: 'Hủy liên kết chuyến bay đã chọn',
      message: `Hủy liên kết ${ids.length} chuyến bay đã chọn?`,
      tone: 'warning',
      confirmLabel: 'Hủy liên kết',
    });
    if (!shouldUnlink) return;

    try {
      const result = unlinkFlightRecords(flightRecords, ids);
      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Hủy liên kết ${result.updatedRecords.length} chuyến bay`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      let nativeSyncMeta: LocalSyncMeta | null = null;
      if (isSeasonalPlanningV1Enabled()) {
        localEditGenerationRef.current += 1;
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: season.id,
          currentRecords: result.records,
          baseRecords: flightRecords,
          expectedRevision: latestDraftRevisionRef.current,
          applyFn: applySeasonalDraftChangesV1,
        });
        setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
        if (saveResult.result.status === 'stale') {
          throw new Error('Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu.');
        }
        if (saveResult.result.status === 'error') {
          throw new Error(saveResult.result.error || 'Lưu thay đổi kế hoạch mùa thất bại.');
        }
        if (saveResult.result.receipt) {
          latestDraftRevisionRef.current = saveResult.result.receipt.revision;
          const draftUndoChanges = buildAuthoritativeDraftUndoChanges(saveResult.result.receipt, flightRecords);
          if (historyEntry) {
            (historyEntry as ModHistoryEntry & { draftUndoChanges?: SeasonalDraftChangeInput[] }).draftUndoChanges = draftUndoChanges;
            setModHistory((prev) => trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...prev])));
          }
          await syncCanonicalDraftAfterCommit(season, saveResult.result.receipt.revision, result.updatedIds);
        }
      } else {
        nativeSyncMeta = await runNativeScheduleMutation(
          season.id,
          result.updatedRecords,
          [],
          [],
          historyEntry
            ? {
                id: historyEntry.id,
                timestamp: historyEntry.timestamp,
                description: historyEntry.description,
              }
            : undefined,
          [],
          'detailed'
        );
        if (!nativeSyncMeta) throw new Error('Cập nhật lịch bay cục bộ không khả dụng.');
        setFlightRecords(result.records);
        patchCachedSeasonData(season.id, { records: result.records });
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: season.id,
          affectedIds: result.updatedIds,
          records: result.updatedRecords,
          syncMeta: nativeSyncMeta,
        });
        if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
        setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
        refreshDetailedState(result.records, currentMods, { preserveSelection: true });
        publishDetailedWorkspaceChange(season.id, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
      }
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: historyEntry?.description ?? `Hủy liên kết ${result.updatedRecords.length} chuyến bay`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
    } catch (err) {
      void showAlert({ title: 'Hủy liên kết thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [
    currentMods,
    flightRecords,
    isMutationBlocked,
    modHistory,
    publishDetailedWorkspaceChange,
    refreshDetailedState,
    season,
    selectedLegs,
    setDraftSaveState,
    setFlightRecords,
    setModHistory,
    setSyncSummary,
    showAlert,
    showConfirm,
    syncCanonicalDraftAfterCommit,
  ]);

  const handleApplyLinkCandidate = useCallback(async (candidate: DetailedLinkCandidate) => {
    if (!season || isMutationBlocked) return;
    try {
      const result = linkFlightRecordPairs(flightRecords, candidate.arrIds, candidate.depIds, candidate.linkType);
      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Liên kết ${result.updatedRecords.length} chuyến bay (${candidate.linkType === 'overnight' ? 'qua đêm' : 'trong ngày'})`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      let nativeSyncMeta: LocalSyncMeta | null = null;
      if (isSeasonalPlanningV1Enabled()) {
        localEditGenerationRef.current += 1;
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: season.id,
          currentRecords: result.records,
          baseRecords: flightRecords,
          expectedRevision: latestDraftRevisionRef.current,
          applyFn: applySeasonalDraftChangesV1,
        });
        setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
        if (saveResult.result.status === 'stale') {
          throw new Error('Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu.');
        }
        if (saveResult.result.status === 'error') {
          throw new Error(saveResult.result.error || 'Lưu thay đổi kế hoạch mùa thất bại.');
        }
        if (saveResult.result.receipt) {
          latestDraftRevisionRef.current = saveResult.result.receipt.revision;
          const draftUndoChanges = buildAuthoritativeDraftUndoChanges(saveResult.result.receipt, flightRecords);
          if (historyEntry) {
            (historyEntry as ModHistoryEntry & { draftUndoChanges?: SeasonalDraftChangeInput[] }).draftUndoChanges = draftUndoChanges;
            setModHistory((prev) => trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...prev])));
          }
          await syncCanonicalDraftAfterCommit(season, saveResult.result.receipt.revision, result.updatedIds);
        }
      } else {
        nativeSyncMeta = await runNativeScheduleMutation(
          season.id,
          result.updatedRecords,
          [],
          [],
          historyEntry
            ? {
                id: historyEntry.id,
                timestamp: historyEntry.timestamp,
                description: historyEntry.description,
              }
            : undefined,
          [],
          'detailed'
        );
        if (!nativeSyncMeta) throw new Error('Cập nhật lịch bay cục bộ không khả dụng.');
        setFlightRecords(result.records);
        patchCachedSeasonData(season.id, { records: result.records });
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: season.id,
          affectedIds: result.updatedIds,
          records: result.updatedRecords,
          syncMeta: nativeSyncMeta,
        });
        if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
        setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
        refreshDetailedState(result.records, currentMods, { preserveSelection: true });
        publishDetailedWorkspaceChange(season.id, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
      }
      setIsLinkModalOpen(false);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: historyEntry?.description ?? `Liên kết ${result.updatedRecords.length} chuyến bay (${candidate.linkType === 'overnight' ? 'qua đêm' : 'trong ngày'})`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
    } catch (err) {
      void showAlert({ title: 'Liên kết thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [
    currentMods,
    flightRecords,
    isMutationBlocked,
    modHistory,
    publishDetailedWorkspaceChange,
    refreshDetailedState,
    season,
    setDraftSaveState,
    setFlightRecords,
    setIsLinkModalOpen,
    setModHistory,
    setSyncSummary,
    showAlert,
    syncCanonicalDraftAfterCommit,
  ]);

  const handleEditNext = useCallback(async (mods: FlightModification[]) => {
    let finalMods = mods;
    const deletedIds = mods.filter((mod) => mod.action === 'deleted').map((mod) => mod.legId);
    if (deletedIds.length > 0) {
      const deletionTargets = resolveLinkedDeletionTargets(allLegs, deletedIds);
      if (deletionTargets.hasActiveCounterpart) {
        const choice = await showChoice({
          title: 'Xóa cặp chuyến bay liên kết',
          message: `Thao tác xóa ảnh hưởng đến ${deletionTargets.selectedIds.length} chuyến bay đã chọn có ${deletionTargets.counterpartIds.length} chuyến đối ứng đang hoạt động.\n\nChọn xóa toàn bộ cặp chuyến hay chỉ xóa chặng bay đã chọn.`,
          tone: 'warning',
          choices: [
            { value: 'pair', label: `Xóa toàn bộ cặp chuyến (${deletionTargets.pairIds.length})`, tone: 'warning' },
            { value: 'selected', label: `Chỉ xóa chặng đã chọn (${deletionTargets.selectedIds.length})` },
            { value: 'cancel', label: 'Hủy' },
          ],
        });
        if (choice === 'pair') {
          const modsById = new Map(finalMods.map((mod) => [mod.legId, mod]));
          for (const id of deletionTargets.counterpartIds) {
            if (!modsById.has(id)) modsById.set(id, { legId: id, action: 'deleted' });
          }
          finalMods = Array.from(modsById.values());
        } else if (choice !== 'selected') {
          return;
        }
      }
    }

    setProposedMods(finalMods);
    setIsEditModalOpen(false);
    setIsConfirmModalOpen(true);
  }, [
    allLegs,
    setIsConfirmModalOpen,
    setIsEditModalOpen,
    setProposedMods,
    showChoice,
  ]);

  const handleDeleteSelectedLegs = useCallback(() => {
    if (
      !season ||
      isMutationBlocked ||
      isEditModalOpen ||
      isConfirmModalOpen ||
      selectedLegs.length === 0
    ) {
      return;
    }
    const deleteMods = selectedLegs.map((leg) => ({ legId: leg.id, action: 'deleted' as const }));
    void handleEditNext(deleteMods);
  }, [handleEditNext, isConfirmModalOpen, isEditModalOpen, isMutationBlocked, season, selectedLegs]);

  const handleAddToDraft = async () => {
    if (!season || isMutationBlocked) return;
    if (proposedMods.length === 0) {
      setIsConfirmModalOpen(false);
      return;
    }
    setIsSaving(true);
    localEditGenerationRef.current += 1;
    try {
      const addedMods = proposedMods.filter((m) => m.action === 'added');
      const regularMods = proposedMods.filter((m) => m.action !== 'added');
      const addedRecords = buildCanonicalAddedFlightRecords(addedMods);
      if (addedRecords.length !== addedMods.length) {
        throw new Error('Dữ liệu chuyến bay thêm mới bị thiếu thông tin chặng.');
      }
      assertNoDuplicateFlightNumbersForEffectiveRecords(
        flightRecords,
        currentMods,
        addedRecords,
        regularMods
      );
      const addedRecordIds = new Set(addedRecords.map((record) => record.id));
      const filteredBaseRecords = flightRecords.filter((record) => !addedRecordIds.has(record.id));
      const modifiedBaseRecords = isSeasonalPlanningV1Enabled()
        ? applyModificationsToFlightRecords(filteredBaseRecords, regularMods)
        : filteredBaseRecords;
      const nextRecords = [
        ...modifiedBaseRecords,
        ...addedRecords,
      ];
      const nextMods = isSeasonalPlanningV1Enabled()
        ? new Map<string, FlightModification>()
        : applyModificationBatch(currentMods, regularMods);
      const baseDraft = draftState ?? {
        baseRecords: flightRecords,
        baseModifications: currentMods,
        modifications: [],
      };
      setFlightRecords(nextRecords);
      setCurrentMods(nextMods);
      patchCachedSeasonData(season.id, { records: nextRecords, modifications: nextMods });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        affectedIds: [
          ...addedRecords.map((record) => record.id),
          ...getAffectedIdsFromDetailedModifications(regularMods),
        ],
        records: nextRecords,
        modifications: nextMods,
      });
      refreshDetailedState(nextRecords, nextMods, { preserveSelection: true });
      if (isSeasonalPlanningV1Enabled()) {
        const historyTimestamp = Date.now();
        const historyEntry = buildFlightRecordHistoryEntry({
          id: `LOCAL_DETAILED_${historyTimestamp}`,
          timestamp: historyTimestamp,
          description: `Áp dụng ${proposedMods.length} thay đổi`,
          beforeRecords: flightRecords,
          afterRecords: nextRecords,
        });
        // History entry will be added with authoritative undo changes once save completes
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: season.id,
          currentRecords: nextRecords,
          baseRecords: flightRecords,
          expectedRevision: latestDraftRevisionRef.current,
          applyFn: applySeasonalDraftChangesV1,
        });
        setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
        if (saveResult.result.status === 'stale') {
          throw new Error('Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu.');
        }
        if (saveResult.result.status === 'error') {
          throw new Error(saveResult.result.error || 'Lưu thay đổi kế hoạch mùa thất bại.');
        }
        if (saveResult.result.status === 'saved' && saveResult.result.receipt) {
          latestDraftRevisionRef.current = saveResult.result.receipt.revision;
          const draftUndoChanges = buildAuthoritativeDraftUndoChanges(saveResult.result.receipt, flightRecords);
          if (historyEntry) {
            setModHistory((prev) => trimUiUndoEntries(filterUiUndoEntriesForSession([{ ...historyEntry, draftUndoChanges }, ...prev])));
          }
          await syncCanonicalDraftAfterCommit(season, saveResult.result.receipt.revision, saveResult.result.receipt.events.map((event) => event.draftId));
        }
      } else {
        setDraftState({
          ...baseDraft,
          modifications: [...baseDraft.modifications, ...proposedMods],
        });
      }
      setProposedMods([]);
      setIsConfirmModalOpen(false);
    } catch (err) {
      console.error(err);
      void showAlert({ title: 'Lưu bản nháp thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const applyModificationToAddedRecord = useCallback((record: FlightRecord, mod: FlightModification | undefined): FlightRecord => {
    if (!mod || mod.action !== 'modified') return record;
    return {
      ...record,
      schedule: mod.schedule ?? record.schedule,
      aircraft: mod.aircraft ?? record.aircraft,
      route: mod.route ?? record.route,
      codeShares: 'codeShares' in mod ? mod.codeShares ?? null : record.codeShares,
      pax: 'pax' in mod ? mod.pax ?? null : record.pax,
      gate: 'gate' in mod ? mod.gate ?? null : record.gate,
      stand: 'stand' in mod ? mod.stand ?? null : record.stand,
      counter: 'counter' in mod ? mod.counter ?? null : record.counter,
      carousel: 'carousel' in mod ? mod.carousel ?? null : record.carousel,
      mct: 'mct' in mod ? mod.mct ?? null : record.mct,
      fb: 'fb' in mod ? mod.fb ?? null : record.fb,
      lb: 'lb' in mod ? mod.lb ?? null : record.lb,
      bhs: 'bhs' in mod ? mod.bhs ?? null : record.bhs,
      ghs: 'ghs' in mod ? mod.ghs ?? null : record.ghs,
    };
  }, []);

  const handleDiscardDraft = useCallback(() => {
    if (!season || !draftState) return;
    setFlightRecords(draftState.baseRecords);
    setCurrentMods(draftState.baseModifications);
    patchCachedSeasonData(season.id, {
      records: draftState.baseRecords,
      modifications: draftState.baseModifications,
    });
    useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
      seasonId: season.id,
      records: draftState.baseRecords,
      modifications: draftState.baseModifications,
    });
    refreshDetailedState(draftState.baseRecords, draftState.baseModifications, { preserveSelection: true });
    localEditGenerationRef.current += 1;
    setDraftState(null);
    setProposedMods([]);
    setIsConfirmModalOpen(false);
  }, [
    draftState,
    refreshDetailedState,
    season,
    setCurrentMods,
    setDraftState,
    setFlightRecords,
    setIsConfirmModalOpen,
    setProposedMods,
  ]);

  const commitDraftBeforeSave = useCallback(async () => {
    if (!season || !draftState || isSaving) return;
    const baseRecordIds = activeCanonicalFlightRecordIds(draftState.baseRecords);
    const addedRecords = flightRecords
      .filter((record) => !baseRecordIds.has(record.id) && currentMods.get(record.id)?.action !== 'deleted')
      .map((record) => applyModificationToAddedRecord(record, currentMods.get(record.id)));
    const regularMods = compactDraftModifications(draftState.modifications, baseRecordIds);
    const targetRecordIds = [...addedRecords.map((record) => record.id), ...regularMods.map((mod) => mod.legId)];

    if (targetRecordIds.length === 0) {
      handleDiscardDraft();
      return;
    }

    const delCount = regularMods.filter((mod) => mod.action === 'deleted').length;
    const modCount = regularMods.filter((mod) => mod.action === 'modified').length;
    const addCount = addedRecords.length;
    const parts: string[] = [];
    if (delCount > 0) parts.push(`Xóa ${delCount}`);
    if (modCount > 0) parts.push(`Điều chỉnh ${modCount}`);
    if (addCount > 0) parts.push(`Thêm mới ${addCount}`);
    const description = `${parts.join(', ')} chuyến bay`;
    const historyTimestamp = Date.now();
    const existingRecordsById = new Map(draftState.baseRecords.map((record) => [record.id, record]));
    const historyEntryBase: ModHistoryEntry = {
      id: `LOCAL_${historyTimestamp}`,
      timestamp: historyTimestamp,
      description,
      changes: regularMods.map((mod) => ({
        legId: mod.legId,
        previousMod: draftState.baseModifications.get(mod.legId) ?? null,
        newMod: mod,
      })),
      recordChanges: addedRecords.map((record) => ({
        recordId: record.id,
        previousRecord: existingRecordsById.get(record.id) ?? null,
        newRecord: record,
      })),
    };
    const historyEntry = withScheduleNotificationPayload(historyEntryBase, {
      season,
      module: 'detailed',
      operation: description,
      beforeRecords: draftState.baseRecords,
      afterRecords: flightRecords,
      beforeModifications: draftState.baseModifications,
      afterModifications: currentMods,
      targetRecordIds,
    });

    setIsSaving(true);
    try {
      if (isSeasonalPlanningV1Enabled()) {
        const appliedBaseRecords = applyModificationsToFlightRecords(draftState.baseRecords, regularMods);
        const currentRecords = [...appliedBaseRecords, ...addedRecords];
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: season.id,
          currentRecords,
          baseRecords: draftState.baseRecords,
          expectedRevision: latestDraftRevisionRef.current,
          applyFn: applySeasonalDraftChangesV1,
        });
        setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
        const planningResult = saveResult.result;
        if (planningResult.status === 'stale') {
          throw new Error('Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu trước khi lưu.');
        }
        if (planningResult.status === 'error') {
          throw new Error(planningResult.error || 'Lưu bản nháp kế hoạch mùa lên máy chủ thất bại.');
        }
        if (planningResult.receipt) {
          latestDraftRevisionRef.current = planningResult.receipt.revision;
        }
        localEditGenerationRef.current += 1;
        // Planning bakes modifications into rows, so undo must restore rows; server events carry the
        // authoritative post-state (deleted rows and survivors the RPC unlinked).
        const committedRecordsById = new Map((planningResult.receipt?.events ?? []).map((event) => [
          event.draftId,
          seasonalDraftToFlightRecord(event.after as unknown as SeasonalDraftRecord),
        ]));
        const planningUndoChanges = planningResult.receipt
          ? buildAuthoritativeDraftUndoChanges(planningResult.receipt, draftState?.baseRecords ?? flightRecords)
          : [];
        const planningHistoryEntry: ModHistoryEntry & { draftUndoChanges?: SeasonalDraftChangeInput[] } = {
          ...historyEntry,
          changes: [],
          draftUndoChanges: planningUndoChanges,
          recordChanges: Array.from(committedRecordsById, ([recordId, newRecord]) => ({
            recordId,
            previousRecord: existingRecordsById.get(recordId) ?? null,
            newRecord,
          })),
        };
        const effectiveRecords = currentRecords
          .map((record) => committedRecordsById.get(record.id) ?? record)
          .filter((record) => record.status !== 'deleted');
        setFlightRecords(effectiveRecords);
        setCurrentMods(new Map());
        patchCachedSeasonData(season.id, {
          records: effectiveRecords,
          modifications: new Map(),
        });
        const committedIds = Array.from(committedRecordsById.keys());
        const planningSyncMeta: LocalSyncMeta = {
          seasonId: season.id,
          localRevision: Number(latestDraftRevisionRef.current) || 0,
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: season.dataVersion ?? 0,
          syncStatus: 'synced',
        };
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: season.id,
          affectedIds: committedIds.length > 0 ? committedIds : targetRecordIds,
          records: effectiveRecords.filter((record) => committedRecordsById.has(record.id)),
          deletedIds: committedIds.filter((id) => committedRecordsById.get(id)?.status === 'deleted'),
          syncMeta: planningSyncMeta,
        });
        publishDetailedWorkspaceChange(season.id, planningSyncMeta.localRevision, targetRecordIds, planningSyncMeta);
        refreshDetailedState(effectiveRecords, new Map(), { preserveSelection: true });
        setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([planningHistoryEntry, ...modHistory])));
        setDraftState(null);
        const reloadSuccess = await syncCanonicalDraftAfterCommit(
          season,
          planningResult.receipt?.revision ?? latestDraftRevisionRef.current,
          committedIds.length > 0 ? committedIds : targetRecordIds
        );
        if (!reloadSuccess) {
          throw new Error('Đã lưu bản nháp thành công nhưng không thể đồng bộ lại dữ liệu mới nhất từ máy chủ.');
        }
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season,
          module: 'detailed',
          operation: description,
          beforeRecords: draftState.baseRecords,
          afterRecords: effectiveRecords,
          beforeModifications: draftState.baseModifications,
          afterModifications: currentMods,
          targetRecordIds,
        }));
        return;
      }

      const commitSeq = ++detailedCommitSeqRef.current;
      const syncMeta = await runNativeScheduleMutation(season.id, addedRecords, [], regularMods, historyEntry, [], 'detailed');
      if (!syncMeta) throw new Error('Cập nhật lịch bay cục bộ không khả dụng.');
      if (commitSeq !== detailedCommitSeqRef.current) {
        await refreshDetailedWindow({ preserveSelection: true });
        return;
      }
      setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: syncMeta.pendingCount, lastLocalChangeAt: syncMeta.lastLocalChangeAt });
      setDraftState(null);
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        affectedIds: targetRecordIds,
        records: addedRecords,
        modifications: regularMods,
        syncMeta,
      });
      publishDetailedWorkspaceChange(season.id, syncMeta.localRevision, targetRecordIds, syncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: description,
        beforeRecords: draftState.baseRecords,
        afterRecords: flightRecords,
        beforeModifications: draftState.baseModifications,
        afterModifications: currentMods,
        targetRecordIds,
      }));
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, [
    applyModificationToAddedRecord,
    currentMods,
    draftState,
    flightRecords,
    handleDiscardDraft,
    isSaving,
    modHistory,
    publishDetailedWorkspaceChange,
    refreshDetailedState,
    refreshDetailedWindow,
    season,
    setCurrentMods,
    setDraftSaveState,
    setDraftState,
    setFlightRecords,
    setIsSaving,
    setModHistory,
    setSyncSummary,
    syncCanonicalDraftAfterCommit,
  ]);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed', {
    blocked: isSaving || isUndoing,
    reason: isSaving ? 'Đang lưu thay đổi lịch chi tiết' : isUndoing ? 'Đang hoàn tác thay đổi lịch chi tiết' : undefined,
    beforeSync: commitDraftBeforeSave,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed-hydration', {
    blocked: loading,
    reason: 'Đang tải bản lưu từ máy chủ',
    quiet: true,
    blockingUi: false,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed-draft', {
    blocked: isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges),
    reason: draftSaveState.status === 'saving'
      ? 'Đang lưu bản nháp kế hoạch chi tiết...'
      : draftSaveState.status === 'error'
        ? 'Lưu bản nháp kế hoạch chi tiết thất bại, có thay đổi chưa xác nhận'
        : 'Có thay đổi bản nháp kế hoạch chi tiết chưa xác nhận',
    quiet: false,
    blockingUi: true,
  });
  const handleOpenPublishModal = useCallback(async () => {
    if (isMutationBlocked) return;
    if (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges)) {
      void showAlert({
        title: 'Chưa thể công bố',
        message: 'Không thể công bố khi bản nháp đang được lưu hoặc có thay đổi chưa được xác nhận bởi máy chủ.',
        tone: 'warning',
      });
      return;
    }
    if (hasDraftChanges) {
      try {
        await commitDraftBeforeSave();
      } catch (err) {
        void showAlert({
          title: 'Chưa thể công bố',
          message: `Lưu thay đổi nháp thất bại: ${formatUiError(err)}. Vui lòng kiểm tra lại.`,
          tone: 'error',
        });
        return;
      }
    }
    setIsPublishModalOpen(true);
  }, [commitDraftBeforeSave, draftSaveState.hasUnconfirmedChanges, draftSaveState.status, hasDraftChanges, isMutationBlocked, setIsPublishModalOpen, showAlert]);

  const handleDraftRestored = useCallback(async () => {
    if (!season) throw new Error('Ngữ cảnh mùa không khả dụng khi nạp lại bản khôi phục.');
    setModHistory([]);
    try {
      const draftData = await loadFullSeasonalDraftRecords(season.id, getSeasonalDraftWindowV1);
      latestDraftRevisionRef.current = draftData.revision;
      latestDraftEpochRef.current = draftData.epoch;
      setDraftSaveState(createInitialDraftSaveState(draftData.revision));
      setHistoryDraftTokens({
        revision: draftData.revision,
        epoch: draftData.epoch,
      });
      setFlightRecords(draftData.records);
      setCurrentMods(new Map());
      setDraftState(null);
      setModHistory([]);
      patchCachedSeasonData(season.id, {
        records: draftData.records,
        modifications: new Map(),
      });
      const syncMeta: LocalSyncMeta = {
        seasonId: season.id,
        localRevision: Number(draftData.revision) || 0,
        pendingCount: 0,
        lastLocalChangeAt: Date.now(),
        baseServerVersion: season.dataVersion ?? 0,
        syncStatus: 'synced',
      };
      setSyncSummary({ pendingCount: 0, lastLocalChangeAt: syncMeta.lastLocalChangeAt });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: season.id,
        season,
        records: draftData.records,
        modifications: new Map(),
        syncMeta,
        windowKey: loadedWindowKeyRef.current ?? undefined,
      });
      refreshDetailedState(draftData.records, new Map(), { preserveSelection: false });
      setCanonicalReloadError(null);
      publishDetailedWorkspaceChange(season.id, syncMeta.localRevision, [], syncMeta);
      void showAlert({
        title: 'Khôi phục Thành công',
        message: `Đã khôi phục thành công dữ liệu lịch bay mùa ${season.seasonCode || season.code} vào bản nháp. Dữ liệu đã sẵn sàng để kiểm tra hoặc công bố lại.`,
        tone: 'success',
      });
    } catch (err: unknown) {
      setCanonicalReloadError(formatUiError(err, 'Lỗi nạp lại bản nháp sau khi khôi phục.'));
      void showAlert({
        title: 'Lỗi nạp lại bản nháp',
        message: formatUiError(err, 'Không thể nạp lại bản nháp sau khi khôi phục.'),
        tone: 'error',
      });
      throw err;
    }
  }, [publishDetailedWorkspaceChange, refreshDetailedState, season, setCurrentMods, setDraftSaveState, setDraftState, setFlightRecords, setHistoryDraftTokens, setModHistory, setSyncSummary, showAlert]);

  const handleBeginRestore = useCallback(() => {
    if (isRestoringDraftRef.current) return true;
    if (isMutationBlocked || currentMods.size > 0) {
      return false;
    }
    isRestoringDraftRef.current = true;
    setIsRestoringDraft(true);
    setIsSaving(true);
    return true;
  }, [currentMods.size, isMutationBlocked, setIsRestoringDraft, setIsSaving]);

  const handleFinishRestore = useCallback(() => {
    isRestoringDraftRef.current = false;
    setIsRestoringDraft(false);
    setIsSaving(false);
  }, [setIsRestoringDraft, setIsSaving]);

  const handleUndo = useCallback(async (targetEntry: ModHistoryEntry) => {
    if (!season || isMutationBlocked) return;
    setIsUndoing(true);
    try {
      const historyToUndoFrom = modHistory;
      const targetIdx = historyToUndoFrom.findIndex(e => e.id === targetEntry.id);
      if (targetIdx === -1) return;
      const entriesToUndo = historyToUndoFrom.slice(0, targetIdx + 1);
      const nextMods = revertModificationHistoryMap(currentMods, entriesToUndo);
      const nextRecords = revertFlightRecordHistoryList(flightRecords, entriesToUndo);
      const undoTimestamp = new Date().getTime();
      const currentRecordsById = new Map(flightRecords.map((record) => [record.id, record]));
      const nextRecordsById = new Map(nextRecords.map((record) => [record.id, record]));
      const undoRecords = new Map<string, FlightRecord>();
      const undoDeletedRecords = new Map<string, FlightRecord>();
      const undoMods = new Map<string, FlightModification>();
      for (const entry of entriesToUndo) {
        for (const change of entry.recordChanges ?? []) {
          if (change.previousRecord) {
            undoRecords.set(change.recordId, change.previousRecord);
            undoDeletedRecords.delete(change.recordId);
          } else {
            const currentRecord = currentRecordsById.get(change.recordId);
            if (currentRecord) {
              undoRecords.delete(change.recordId);
              undoDeletedRecords.set(change.recordId, currentRecord);
            }
          }
        }
        for (const change of entry.changes) {
          if (change.previousMod) {
            undoMods.set(change.legId, change.previousMod);
          } else {
            const baseRecord = currentRecordsById.get(change.legId) ?? nextRecordsById.get(change.legId);
            if (baseRecord) undoMods.set(change.legId, noOpModificationForRecord(baseRecord));
          }
        }
      }
      const rollbackState = captureDetailedOptimisticRollbackState();
      const commitSeq = ++detailedCommitSeqRef.current;
      const nextHistory = trimUiUndoEntries(filterUiUndoEntriesForSession(historyToUndoFrom.slice(targetIdx + 1)));
      setFlightRecords(nextRecords);
      setCurrentMods(nextMods);
      setModHistory(nextHistory);
      patchCachedSeasonData(season.id, { records: nextRecords, modifications: nextMods });
      refreshDetailedState(nextRecords, nextMods, { preserveSelection: true });
      let syncMeta: Awaited<ReturnType<typeof runNativeScheduleMutation>>;
      try {
        if (isSeasonalPlanningV1Enabled()) {
          const undoChanges = composeSeasonalDraftUndoChanges(
            entriesToUndo.flatMap((entry) => (entry as ModHistoryEntry & { draftUndoChanges?: SeasonalDraftChangeInput[] }).draftUndoChanges ?? [])
          );

          localEditGenerationRef.current += 1;
          setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
          const saveResult = await executeSeasonalPlanningDraftSave({
            seasonId: season.id,
            currentRecords: nextRecords,
            baseRecords: flightRecords,
            expectedRevision: latestDraftRevisionRef.current,
            applyFn: applySeasonalDraftChangesV1,
            changes: undoChanges.length > 0 ? undoChanges : undefined,
          });
          setDraftSaveState((prev) => ({ ...saveResult.state, lastSavedAt: saveResult.state.lastSavedAt ?? prev.lastSavedAt }));
          if (saveResult.result.status === 'stale') {
            throw new Error('Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu.');
          }
          if (saveResult.result.status === 'error') {
            throw new Error(saveResult.result.error || 'Lưu thay đổi kế hoạch mùa thất bại.');
          }
          const affectedIds = entriesToUndo.flatMap((entry) => [
            ...entry.changes.map((change) => change.legId),
            ...(entry.recordChanges?.map((change) => change.recordId) ?? []),
          ]);
          if (saveResult.result.receipt) {
            latestDraftRevisionRef.current = saveResult.result.receipt.revision;
            const scope = readDetailedRowScope(detailedScopeToken);
            if (scope && scope.seasonId === season.id && detailedScopeToken) {
              const ids = new Set(scope.recordIds);
              for (const entry of entriesToUndo) {
                const changes = entry.recordChanges ?? [];
                if (changes.some(change => ids.has(change.recordId))) {
                  for (const change of changes) ids.add(change.recordId);
                }
              }
              extendDetailedRowScope(detailedScopeToken, [...ids]);
            }
            await syncCanonicalDraftAfterCommit(season, saveResult.result.receipt.revision, affectedIds, true);
          }
          setIsUndoOpen(false);
          void appendAuditLogEntry(createFlightActionAuditFromHistory({
            season,
            module: 'detailed',
            operation: `Hoàn tác ${targetEntry.description}`,
            beforeRecords: flightRecords,
            afterRecords: nextRecords,
            beforeModifications: currentMods,
            afterModifications: nextMods,
            targetRecordIds: affectedIds,
          }));
          return;
        } else {
          syncMeta = await runNativeScheduleMutation(
            season.id,
            Array.from(undoRecords.values()),
            Array.from(undoDeletedRecords.values()),
            Array.from(undoMods.values()),
            {
              id: `LOCAL_UNDO_${undoTimestamp}`,
              timestamp: undoTimestamp,
              description: `Hoàn tác ${targetEntry.description}`,
            },
            [],
            'detailed'
          );
        }
        if (!syncMeta) throw new Error('Cập nhật lịch bay cục bộ không khả dụng.');
      } catch (error) {
        if (commitSeq === detailedCommitSeqRef.current) restoreDetailedOptimisticState(rollbackState);
        throw error;
      }
      if (commitSeq !== detailedCommitSeqRef.current) {
        await refreshDetailedWindow({ preserveSelection: true });
        return;
      }
      const affectedIds = entriesToUndo.flatMap((entry) => [
        ...entry.changes.map((change) => change.legId),
        ...(entry.recordChanges?.map((change) => change.recordId) ?? []),
      ]);
      setSyncSummary({ pendingCount: syncMeta.pendingCount, lastLocalChangeAt: syncMeta.lastLocalChangeAt });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: season.id,
        affectedIds,
        records: nextRecords,
        modifications: nextMods,
        syncMeta,
      });
      publishDetailedWorkspaceChange(season.id, syncMeta.localRevision, affectedIds, syncMeta);
      setIsUndoOpen(false);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: `Hoàn tác ${targetEntry.description}`,
        beforeRecords: flightRecords,
        afterRecords: nextRecords,
        beforeModifications: currentMods,
        afterModifications: nextMods,
        targetRecordIds: affectedIds,
      }));
    } catch (err) {
      console.error(err);
      void showAlert({ title: 'Hoàn tác thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setIsUndoing(false);
    }
  }, [
    canonicalReloadError,
    captureDetailedOptimisticRollbackState,
    detailedScopeToken,
    currentMods,
    flightRecords,
    isMutationBlocked,
    modHistory,
    publishDetailedWorkspaceChange,
    refreshDetailedState,
    refreshDetailedWindow,
    restoreDetailedOptimisticState,
    season,
    setCurrentMods,
    setDraftSaveState,
    setFlightRecords,
    setIsUndoOpen,
    setIsUndoing,
    setModHistory,
    setSyncSummary,
    showAlert,
    syncCanonicalDraftAfterCommit,
  ]);

  const handleSync = useCallback(async () => {
    if (!season || syncInProgress) return;
    try {
      const result = await syncNow();
      void showAlert({
        title: result.status === 'synced' ? 'Lưu thành công' : 'Lưu thất bại',
        message: result.message ?? 'Không có thay đổi cục bộ nào cần lưu.',
        tone: result.status === 'synced' ? 'success' : 'error',
      });
    } catch (err) {
      void showAlert({ title: 'Lưu thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [season, showAlert, syncInProgress, syncNow]);

  const fetchServerData = useCallback(async () => {
    if (!season || fetchingServerData || syncInProgress) return;
    if (hasDraftChanges) return;
    const queryWindow = buildDetailedScheduleQueryWindow({
      dateFrom: targetDateFrom || fromDate || null,
      dateTo: targetDateTo || toDate || null,
      targetArrFlight,
      targetDepFlight,
    });
    const windowKey = buildDetailedWindowKey(queryWindow);
    const requestId = ++fetchServerDataRequestRef.current;
    const requestedSeasonId = season.id;
    const hasRouteDataLoaded = loadedWindowKeyRef.current === windowKey;
    setFetchingServerData(true);
    if (!hasRouteDataLoaded) setLoadError(null);
    setLoadProgress(buildLoadProgress('Đang tải dữ liệu từ máy chủ', 35, season.seasonCode));
    try {
      if (isSeasonalPlanningV1Enabled()) {
        const records = await applyPlanningDraftWindow(season, windowKey, true);
        if (records) return;
      }
      const serverWindow = await revalidateSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: queryWindow.dateFrom,
        dateTo: queryWindow.dateTo,
        resourceType: 'schedule',
        limit: 100000,
      }, {
        force: true,
        initiator: 'immediate',
      });
      if (!serverWindow?.syncMeta) throw new Error('Không thể tải dữ liệu lịch chi tiết từ máy chủ.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== windowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = windowKey;
      setLoadProgress(buildLoadProgress('Đang hiển thị lịch bay', 80, `${serverWindow.records.length} bản ghi`));
      setFlightRecords(serverWindow.records);
      setCurrentMods(serverWindow.modifications);
      setDraftState(null);
      setSyncSummary({
        pendingCount: serverWindow.syncMeta.pendingCount,
        lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
      });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: season.id,
        season,
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
      refreshDetailedState(serverWindow.records, serverWindow.modifications, { preserveSelection: true });
    } catch (err) {
      const message = formatUiError(err, 'Không thể tải dữ liệu lịch chi tiết từ máy chủ.');
      if (!hasRouteDataLoaded) setLoadError(message);
      void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [
    applyPlanningDraftWindow,
    fetchingServerData,
    fromDate,
    hasDraftChanges,
    refreshDetailedState,
    season,
    setCurrentMods,
    setDraftState,
    setFetchingServerData,
    setFlightRecords,
    setLoadError,
    setLoadProgress,
    setSyncSummary,
    showAlert,
    syncInProgress,
    targetArrFlight,
    targetDateFrom,
    targetDateTo,
    targetDepFlight,
    toDate,
  ]);

  const handleSeasonalNavigation = () => {
    if (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges || Boolean(canonicalReloadError))) {
      void showAlert({
        title: 'Chưa thể chuyển trang',
        message: draftSaveState.status === 'saving'
          ? 'Đang lưu bản nháp, vui lòng đợi hoàn tất trước khi rời khỏi trang.'
          : canonicalReloadError
          ? 'Đang có lỗi nạp lại dữ liệu bản nháp sau khi lưu. Vui lòng thử lại trước khi rời đi.'
          : 'Có thay đổi chưa được xác nhận bởi máy chủ. Vui lòng thử lại lưu nháp trước khi rời đi.',
        tone: 'warning',
      });
      return;
    }
    if (season && typeof window !== 'undefined') {
      sessionStorage.setItem('activeSeasonId', season.id);
    }
    router.push('/seasonal');
  };

  const handleShowKeyboardShortcuts = () => {
    void showAlert({
      title: 'Phím tắt bàn phím',
      message: [
        'Ctrl+C = Sao chép chuyến bay đã chọn',
        'Ctrl+V = Dán chuyến bay đã sao chép vào (các) ngày đã chọn',
        'Ctrl+A = Chọn tất cả ngày và chuyến bay hiển thị',
        'Shift+Click = Chọn khoảng ngày',
      ].join('\n'),
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Xử lý bộ lọc lịch bay', 15, 'Chuẩn bị lịch chi tiết'));
      try {
        let activeSeasonId = targetSeasonId;
        let activeArr = targetArrFlight;
        let activeDep = targetDepFlight;
        let activeFrom = targetDateFrom;
        let activeTo = targetDateTo;

        if (typeof window !== 'undefined') {
          if (!activeSeasonId) {
            activeSeasonId = sessionStorage.getItem('detailed_season') || sessionStorage.getItem('activeSeasonId');
            activeArr = null;
            activeDep = null;
            activeFrom = null;
            activeTo = null;
          }

          if (!hasExplicitDetailedFlightSelection) {
            activeArr = null;
            activeDep = null;
            if (!targetDateFrom) activeFrom = null;
            if (!targetDateTo) activeTo = null;
          }

          // Save the current resolved state
          if (activeSeasonId) {
            sessionStorage.setItem('detailed_season', activeSeasonId);
            sessionStorage.setItem('activeSeasonId', activeSeasonId);
          }
          sessionStorage.setItem('detailed_arr', hasExplicitDetailedFlightSelection ? activeArr || '' : '');
          sessionStorage.setItem('detailed_dep', hasExplicitDetailedFlightSelection ? activeDep || '' : '');
          sessionStorage.setItem('detailed_from', activeFrom || '');
          sessionStorage.setItem('detailed_to', activeTo || '');
        }

        if (!activeSeasonId) {
          router.replace('/');
          return;
        }

        // If URL doesn't match the resolved state, redirect to sync URL
        if (
          targetSeasonId !== activeSeasonId ||
          targetArrFlight !== activeArr ||
          targetDepFlight !== activeDep ||
          targetDateFrom !== activeFrom ||
          targetDateTo !== activeTo
        ) {
          const params = new URLSearchParams();
          params.set('season', activeSeasonId);
          if (activeArr) params.set('arrFlight', activeArr);
          if (activeDep) params.set('depFlight', activeDep);
          if (activeFrom) params.set('dateFrom', activeFrom);
          if (activeTo) params.set('dateTo', activeTo);
          router.replace(`/detailed?${params.toString()}`);
          return; // Allow the URL change to trigger the next render cycle
        }

        const cachedSeasons = getCachedSeasons();
        setLoadProgress(buildLoadProgress('Đang tải danh sách mùa', 25, activeSeasonId));
        const seasons = cachedSeasons ?? await getSeasons();
        if (cancelled) return;
        if (!cachedSeasons) setCachedSeasons(seasons);
        useSeasonWorkspaceStore.getState().setSeasons(seasons);
        const found = seasons.find((s) => s.id === activeSeasonId);
        if (!found) {
          router.replace('/');
          return;
        }
        setSeason(found);

        const initialFrom = activeFrom || found.effectiveStart || '';
        const initialTo = activeTo || found.effectiveEnd || '';
        setFromDate(initialFrom);
        setToDate(initialTo);

        const queryWindow = buildDetailedScheduleQueryWindow({
          dateFrom: initialFrom || null,
          dateTo: initialTo || null,
          targetArrFlight: activeArr,
          targetDepFlight: activeDep,
        });
        const windowKey = buildDetailedWindowKey(queryWindow);
        if (isSeasonalPlanningV1Enabled()) {
          setLoadProgress(buildLoadProgress('Đang tải bản nháp lịch mùa', 25, found.seasonCode));
          try {
            const draftData = await loadFullSeasonalDraftRecords(found.id, getSeasonalDraftWindowV1);
            if (cancelled) return;
            loadedWindowKeyRef.current = windowKey;
            latestDraftRevisionRef.current = draftData.revision;
            latestDraftEpochRef.current = draftData.epoch;
            setDraftSaveState(createInitialDraftSaveState(draftData.revision));
            const canonicalRecords = draftData.records;
            const mods = new Map<string, FlightModification>();
            const syncMeta: LocalSyncMeta = {
              seasonId: found.id,
              localRevision: Number(draftData.revision) || 0,
              pendingCount: 0,
              lastLocalChangeAt: Date.now(),
              baseServerVersion: found.dataVersion ?? 0,
              syncStatus: 'synced',
            };
            setLoadProgress(buildLoadProgress('Đang hiển thị lịch bay', 80, `${canonicalRecords.length} bản ghi`));
            setSyncSummary({ pendingCount: 0, lastLocalChangeAt: Date.now() });
            setLoadProgress(buildLoadProgress('Đang hiển thị lịch bay', 95, 'Áp dụng bộ lọc'));
            setFlightRecords(canonicalRecords);
            setCurrentMods(mods);
            useSeasonWorkspaceStore.getState().replaceSeasonWindow({
              seasonId: found.id,
              season: found,
              records: canonicalRecords,
              modifications: mods,
              syncMeta,
              windowKey,
            });
            publishSeasonWorkspaceChanged({
              seasonId: found.id,
              localRevision: syncMeta.localRevision,
              source: 'server-window',
              syncMeta,
            });
            refreshDetailedStateRef.current(canonicalRecords, mods);
            return;
          } catch (err) {
            if (!isDraftWorkspaceNotFoundError(err)) {
              throw err;
            }
          }
        }

        const workspace = useSeasonWorkspaceStore.getState().workspaces[found.id];
        const freshWindow = readCachedWorkspaceWindow(workspace, windowKey);
        const cachedWindow = freshWindow ?? readWorkspaceWindowSnapshot(workspace, windowKey);
        if (cachedWindow?.syncMeta) {
          loadedWindowKeyRef.current = windowKey;
          setFlightRecords(cachedWindow.records);
          setCurrentMods(cachedWindow.modifications);
          setSyncSummary({
            pendingCount: cachedWindow.syncMeta.pendingCount,
            lastLocalChangeAt: cachedWindow.syncMeta.lastLocalChangeAt,
          });
          refreshDetailedStateRef.current(cachedWindow.records, cachedWindow.modifications, { preserveSelection: true });
          if (freshWindow) return;
          setLoading(false);
        }

        setLoadProgress(buildLoadProgress('Đang tải dữ liệu từ máy chủ', 35, found.seasonCode));
        const serverWindow = await loadSeasonWorkspaceWindow({
          seasonId: found.id,
          dateFrom: queryWindow.dateFrom,
          dateTo: queryWindow.dateTo,
          resourceType: 'schedule',
          limit: 100000,
        });
        if (cancelled) return;
        if (serverWindow) {
          loadedWindowKeyRef.current = windowKey;
          const canonicalRecords = serverWindow.records;
          const mods = serverWindow.modifications;
          setLoadProgress(buildLoadProgress(
            'Đang hiển thị lịch bay',
            80,
            `${canonicalRecords.length} bản ghi`
          ));
          setSyncSummary({
            pendingCount: serverWindow.syncMeta.pendingCount,
            lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
          });
          setLoadProgress(buildLoadProgress('Đang hiển thị lịch bay', 95, 'Áp dụng bộ lọc'));
          setFlightRecords(canonicalRecords);


          setCurrentMods(mods);
          useSeasonWorkspaceStore.getState().replaceSeasonWindow({
            seasonId: found.id,
            season: found,
            records: canonicalRecords,
            modifications: mods,
            syncMeta: serverWindow.syncMeta,
            windowKey,
          });
          publishSeasonWorkspaceChanged({
            seasonId: found.id,
            localRevision: serverWindow.syncMeta.localRevision,
            source: 'server-window',
            syncMeta: serverWindow.syncMeta,
          });
          refreshDetailedStateRef.current(canonicalRecords, mods);
          if (isSeasonalPlanningV1Enabled()) {
            try {
              const draftWindow = await getSeasonalDraftWindowV1({ seasonId: found.id, pageSize: 1 });
              latestDraftRevisionRef.current = draftWindow.revision;
              latestDraftEpochRef.current = draftWindow.epoch;
            } catch {
              // Draft window RPC fallback
            }
          }
          return;
        }
        throw new Error('Không thể tải dữ liệu lịch chi tiết từ máy chủ.');
      } catch (err) {
        if (!cancelled) {
          console.error('Error loading detailed schedule', err);
          setLoadError(formatUiError(err, 'Không thể tải dữ liệu lịch chi tiết từ máy chủ.'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasExplicitDetailedFlightSelection, router, setFromDate, setToDate, showAlert, targetArrFlight, targetDateFrom, targetDateTo, targetDepFlight, targetSeasonId]);

  useEffect(() => {
    if (!isRouteActive) return undefined;
    const handleGlobalMouseUp = () => {
      if (isSelecting) {
        setIsSelecting(false);
        setSelectionStart(null);
        setSelectionEnd(null);
        setSelectionMode('replace');
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isRouteActive, isSelecting]);

  // Ctrl+C / Ctrl+V keyboard handler
  useEffect(() => {
    if (!isRouteActive) return undefined;
    const handleKeyboard = (e: KeyboardEvent) => {
      const isInputFocused =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable);
      if (isInputFocused) return;

      if (
        e.key === 'Delete' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        if (isMutationBlocked) return;
        e.preventDefault();
        handleDeleteSelectedLegs();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (singleSelectedLeg) {
          setCopiedLeg(singleSelectedLeg);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (isMutationBlocked) return;
        if (copiedLeg && sweepSelectedDates.length > 0) {
          try {
            const transferPairContext = buildDetailedTransferPairContext(allLegs);
            const newMods: FlightModification[] = [];

            sweepSelectedDates.forEach(targetDate => {
              newMods.push(...buildDetailedTransferModifications({
                sourceLeg: copiedLeg,
                visibleLegs: legs,
                allLegs,
                targetDate,
                mode: 'copy',
                pairContext: transferPairContext,
              }));
            });

            if (newMods.length > 0) {
              setProposedMods(newMods);
              setIsConfirmModalOpen(true);
            }
          } catch (err) {
            void showAlert({ title: 'Không thể sao chép chuyến bay', message: formatUiError(err), tone: 'error' });
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const start = targetDateFrom || fromDate;
        const end = targetDateTo || toDate;
        if (start && end) {
          const allDates: string[] = [];
          const cur = new Date(start);
          const endDate = new Date(end);
          while (cur <= endDate) {
            allDates.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
            cur.setDate(cur.getDate() + 1);
          }
          setSweepSelectedDates(allDates);
          const dateSet = new Set(allDates);
          const visibleLegIds = new Set(legs.filter(l => dateSet.has(l.date)).map(l => l.id));
          setSelectedLegIds(visibleLegIds);
        }
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [singleSelectedLeg, copiedLeg, sweepSelectedDates, legs, allLegs, fromDate, toDate, targetDateFrom, targetDateTo, isRouteActive, isMutationBlocked, handleDeleteSelectedLegs, showAlert]);

  // Calendar Logic
  const calendarDays = useMemo(() => {
    if (!fromDate || !toDate) return [];
    const start = new Date(fromDate);
    const end = new Date(toDate);
    
    if (start > end) return [];

    const days = [];
    
    // Padding start (Mon = 0, Sun = 6)
    const jsDay = start.getDay();
    const padStart = jsDay === 0 ? 6 : jsDay - 1;
    
    for (let i = 0; i < padStart; i++) {
      days.push(null);
    }
    
    const current = new Date(start);
    while (current <= end) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    
    // Pad end
    const remainder = days.length % 7;
    if (remainder !== 0) {
      for (let i = 0; i < 7 - remainder; i++) {
        days.push(null);
      }
    }
    
    return days;
  }, [fromDate, toDate]);

  const legsByDate = useMemo(() => {
    const map = new Map<string, FlightLeg[]>();
    legs.forEach(leg => {
      const existing = map.get(leg.date) || [];
      existing.push(leg);
      map.set(leg.date, existing);
    });
    return map;
  }, [legs]);

  const confirmRecordsById = useMemo(() => {
    const map = new Map<string, FlightLeg>();
    for (const leg of allLegs) map.set(leg.id, leg);
    for (const leg of legs) map.set(leg.id, leg);
    for (const mod of proposedMods) {
      if (mod.action === 'added' && mod.addedLeg) map.set(mod.legId, mod.addedLeg);
    }
    return map;
  }, [allLegs, legs, proposedMods]);

  const calendarDateKeys = useMemo(() => calendarDays.map((dateObj) => {
    if (!dateObj) return null;
    return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  }), [calendarDays]);

  const activeSelectionDates = useMemo(() => {
    if (!isSelecting || !selectionStart || !selectionEnd) return [];
    return buildSpatialCalendarDateSelection(calendarDateKeys, selectionStart, selectionEnd);
  }, [calendarDateKeys, isSelecting, selectionEnd, selectionStart]);

  const activeSelectionDateSet = useMemo(() => new Set(activeSelectionDates), [activeSelectionDates]);

  const isCellInSelection = useCallback((dateStr: string) => {
    return activeSelectionDateSet.has(dateStr);
  }, [activeSelectionDateSet]);

  const handleMouseDownCell = (e: React.MouseEvent<HTMLDivElement>, dateStr: string) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    setIsSelecting(true);
    setSelectionStart(dateStr);
    setSelectionEnd(dateStr);
    setSelectionMode((e.ctrlKey || e.metaKey) ? 'append' : 'replace');
    suppressNextCellClickRef.current = false;
  };

  const handleMouseEnterCell = (dateStr: string) => {
    if (isSelecting) {
      setSelectionEnd(dateStr);
    }
  };

  const handleMouseUpCell = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isSelecting && selectionStart && selectionEnd && selectionStart !== selectionEnd) {
      e.preventDefault();
      suppressNextCellClickRef.current = true;
      const selectedDates = buildSpatialCalendarDateSelection(calendarDateKeys, selectionStart, selectionEnd);
      const selectedDateSet = new Set(selectedDates);
      const newSelectedLegIds = selectionMode === 'append' ? new Set(selectedLegIds) : new Set<string>();
      legs.forEach(leg => {
        if (selectedDateSet.has(leg.date)) {
          newSelectedLegIds.add(leg.id);
        }
      });
      setSweepSelectedDates(prev => mergeCalendarDateSelections(prev, selectedDates, selectionMode));
      setSelectedLegIds(newSelectedLegIds);
    }
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
    setSelectionMode('replace');
  };

  const handleDragStart = (e: React.DragEvent, leg: FlightLeg) => {
    if (isMutationBlocked) {
      e.preventDefault();
      return;
    }
    const legIds = selectedLegIds.has(leg.id) && selectedLegIds.size > 1
      ? Array.from(selectedLegIds)
      : [leg.id];
    e.dataTransfer.setData('text/plain', JSON.stringify({ legId: leg.id, legIds, sourceDate: leg.date }));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (isMutationBlocked) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
  };

  const handleDrop = (e: React.DragEvent, targetDateStr: string) => {
    e.preventDefault();
    if (isMutationBlocked) return;
    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;
    const isCopy = e.ctrlKey || e.metaKey;
    try {
      const parsed = JSON.parse(data);
      const legIds: string[] = Array.isArray(parsed.legIds) && parsed.legIds.length > 0
        ? parsed.legIds
        : parsed.legId
        ? [parsed.legId]
        : [];
      if (legIds.length === 0) return;
      const legsById = new Map<string, FlightLeg>();
      for (const leg of allLegs) legsById.set(leg.id, leg);
      for (const leg of legs) legsById.set(leg.id, leg);
      const sourceLegs = legIds.map((id) => legsById.get(id)).filter(Boolean) as FlightLeg[];
      if (sourceLegs.length === 0) return;

      const anchorDate = parsed.sourceDate || sourceLegs[0]?.date || targetDateStr;
      const anchorMillis = new Date(anchorDate).getTime();
      const targetMillis = new Date(targetDateStr).getTime();
      const dayDiff = Math.round((targetMillis - anchorMillis) / (24 * 60 * 60 * 1000));
      if (dayDiff === 0 && !isCopy) return;

      const transferPairContext = buildDetailedTransferPairContext(allLegs);
      const newMods: FlightModification[] = [];
      const handledPairKeys = new Set<string>();

      for (const sourceLeg of sourceLegs) {
        const pairKey = sourceLeg.turnaroundId
          ? `turnaround:${sourceLeg.turnaroundId}`
          : sourceLeg.linkId
          ? `link:${sourceLeg.linkId}:${sourceLeg.pairAnchorDate ?? sourceLeg.date}`
          : null;
        if (pairKey && handledPairKeys.has(pairKey)) continue;

        const legDateMillis = new Date(sourceLeg.date).getTime();
        const legTargetDateObj = new Date(legDateMillis + dayDiff * 24 * 60 * 60 * 1000);
        const legTargetDateStr = `${legTargetDateObj.getFullYear()}-${String(legTargetDateObj.getMonth() + 1).padStart(2, '0')}-${String(legTargetDateObj.getDate()).padStart(2, '0')}`;

        const mods = buildDetailedTransferModifications({
          sourceLeg,
          visibleLegs: legs,
          allLegs,
          targetDate: legTargetDateStr,
          mode: isCopy ? 'copy' : 'move',
          pairContext: transferPairContext,
        });
        newMods.push(...mods);
        if (pairKey) handledPairKeys.add(pairKey);
      }

      if (newMods.length > 0) {
        setProposedMods(newMods);
        setIsConfirmModalOpen(true);
      }
    } catch (err) {
      console.error('Drop error', err);
      void showAlert({
        title: isCopy ? 'Không thể sao chép chuyến bay' : 'Không thể di chuyển chuyến bay',
        message: formatUiError(err),
        tone: 'error',
      });
    }
  };

  const handleExport = useCallback(async () => {
    if (!season || legs.length === 0 || isMutationBlocked) return;
    try {
      const ws = XLSX.utils.json_to_sheet(legs.map(l => ({
        Date: l.date,
        Type: l.type,
        Flight: l.flightNumber,
        Route: l.route,
        Aircraft: l.aircraft,
        Schedule: l.schedule,
        LinkID: l.linkId,
        Action: l.action || 'original'
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'DetailedSchedule');
      const result = await saveWorkbookAsXlsx(wb, `Detailed_${season.seasonCode}_${Date.now()}.xlsx`);
      notifyExportCompleted(result);
    } catch (err) {
      void showAlert({ title: 'Xuất tệp thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [isMutationBlocked, legs, notifyExportCompleted, season, showAlert]);

  if (loading) {
    return <LoadingStatusPanel progress={loadProgress} mode="fullscreen" />;
  }

  if (loadError) {
    return (
      <div className="flex h-dvh items-center justify-center bg-surface p-6">
        <div className="max-w-xl rounded-lg border border-error/30 bg-surface-container-lowest p-6 text-center shadow-sm">
          <div className="font-title-sm text-title-sm text-error">Không thể tải lịch chi tiết</div>
          <div className="mt-2 font-body-sm text-body-sm text-on-surface-variant">{loadError}</div>
          {syncSeasonId && (
            <div className="mt-4 flex justify-center">
              <FetchServerUpdatesButton
                fetching={fetchingServerData}
                progress={fetchProgress}
                disabled={syncInProgress}
                onFetch={fetchServerData}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-surface h-dvh overflow-hidden">
        <WorkspacePageHeader
          leading={(
            <button onClick={handleSeasonalNavigation} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container-high" title="Quay lại Lịch mùa" aria-label="Quay lại Lịch mùa">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
          )}
          title="Lịch chi tiết"
          subtitle={season ? `${buildSeasonDisplayLabel(season)}${(targetArrFlight || targetDepFlight) ? ` (Đã lọc theo ${targetArrFlight || ''} ${targetArrFlight && targetDepFlight ? '/' : ''} ${targetDepFlight || ''})` : ''}` : 'Chưa chọn mùa'} 
          statusControls={season && (
            isSeasonalPlanningV1Enabled() ? (
              <>
                {draftSaveState.status === 'saving' && (
                  <span className="flex items-center gap-1.5 rounded-full border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800">
                    <span className="material-symbols-outlined animate-spin text-[16px]">sync</span>
                    <span>Đang lưu nháp...</span>
                  </span>
                )}
                {draftSaveState.status === 'saved' && (
                  <span className="flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                    <span>Đã lưu nháp (rev {draftSaveState.revision})</span>
                  </span>
                )}
                {draftSaveState.status === 'error' && (
                  <span className="flex items-center gap-1.5 rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800">
                    <span className="material-symbols-outlined text-[16px]">error</span>
                    <span>Lỗi lưu nháp</span>
                    <button
                      type="button"
                      onClick={() => { void handleRetryDraftSave(); }}
                      className="ml-1 rounded bg-red-700 px-2 py-0.5 text-xs text-white hover:bg-red-800 font-medium"
                    >
                      Thử lại
                    </button>
                  </span>
                )}
                {canonicalReloadError && (
                  <span role="status" className="flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950" title={canonicalReloadError}>
                    <span>Đã lưu trên máy chủ; chưa nạp lại được bản nháp</span>
                    <button
                      type="button"
                      disabled={draftSaveState.status === 'saving'}
                      onClick={() => { void handleRetryDraftSave(); }}
                      className="ml-1 rounded bg-amber-800 px-2 py-0.5 text-xs text-white disabled:opacity-50"
                    >
                      Nạp lại bản nháp
                    </button>
                  </span>
                )}
                {draftSaveState.status === 'stale' && (
                  <span className="flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950">
                    <span className="material-symbols-outlined text-[16px]">warning</span>
                    <span>Xung đột phiên bản</span>
                    <button
                      type="button"
                      onClick={() => { void refreshDetailedWindow({ revalidate: true }); }}
                      className="ml-1 rounded bg-amber-800 px-2 py-0.5 text-xs text-white hover:bg-amber-700 font-medium"
                    >
                      Tải lại
                    </button>
                  </span>
                )}
                <FetchServerUpdatesButton
                  fetching={fetchingServerData}
                  progress={fetchProgress}
                  disabled={syncInProgress || (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges)}
                  onFetch={fetchServerData}
                />
              </>
            ) : (
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
                  draftCount={draftChangeCount}
                  progress={syncProgress}
                  onSync={handleSync}
                />
              </>
            )
          )}
          draftControls={!isSeasonalPlanningV1Enabled() && hasDraftChanges && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900">
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              <span className="text-xs font-semibold">{draftChangeCount} thay đổi nháp</span>
              <button
                onClick={handleDiscardDraft}
                disabled={isSaving || syncInProgress}
                className="rounded px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Hủy bỏ
              </button>
            </div>
          )}
          primaryActions={(
            <>
              <button
                onClick={() => setIsNewFlightOpen(true)}
                disabled={!newFlightDateSelection || isMutationBlocked}
                title={newFlightDateSelection ? `Thêm chuyến bay vào ${newFlightDateLabel}` : 'Chọn ô ngày trước'}
                className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                Thêm chuyến bay
              </button>
              {isSeasonalPlanningV1Enabled() && season && (
                <button
                  onClick={() => { void handleOpenPublishModal(); }}
                  disabled={isMutationBlocked}
                  title="Công bố lịch bay mùa sang phân hệ Vận hành (Operations)"
                  className="flex min-h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 font-label-caps text-label-caps text-white shadow-sm transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">publish</span>
                  Công bố lịch bay
                </button>
              )}
              {isSeasonalPlanningV1Enabled() && season && (
                <button
                  onClick={() => {
                    setHistoryDraftTokens({
                      revision: latestDraftRevisionRef.current,
                      epoch: latestDraftEpochRef.current,
                    });
                    setIsHistoryModalOpen(true);
                  }}
                  disabled={isMutationBlocked}
                  title="Xem lịch sử các phiên bản đã công bố, so sánh và khôi phục"
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant bg-surface px-4 py-2 font-label-caps text-label-caps text-on-surface shadow-sm transition-colors hover:bg-surface-variant/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">history</span>
                  Lịch sử phiên bản
                </button>
              )}
              <button
                onClick={handleShowKeyboardShortcuts}
                className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-[18px]">keyboard</span>
                Phím tắt
              </button>
              {copiedLeg && (
                <span className="flex min-h-10 items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-xs font-medium text-amber-800">
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  {copiedLeg.flightNumber}
                  {sweepSelectedDates.length > 0 && (
                    <span className="ml-1 text-amber-600">sang {sweepSelectedDates.length} ngày (Ctrl+V)</span>
                  )}
                </span>
              )}
            </>
          )}
          secondaryActions={(
            <>
              <div className="hidden flex-wrap items-center gap-2 xl:flex">
                <button
                  onClick={() => setIsLinkModalOpen(true)}
                  disabled={linkCandidates.length === 0 || isMutationBlocked}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">link</span>
                  Liên kết
                </button>
                <button
                  onClick={handleUnlinkSelected}
                  disabled={isMutationBlocked || !selectedLegs.some((leg) => leg.linkType || leg.linkedRecordId)}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">link_off</span>
                  Hủy liên kết
                </button>
                <button
                  onClick={handleExport}
                  disabled={isMutationBlocked || !season || legs.length === 0}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  Xuất Excel
                </button>
              </div>
              <HeaderActionMenu
                className="xl:hidden"
                items={[
                  { label: 'Liên kết', icon: 'link', onSelect: () => setIsLinkModalOpen(true), disabled: linkCandidates.length === 0 || isMutationBlocked },
                  { label: 'Hủy liên kết', icon: 'link_off', onSelect: () => void handleUnlinkSelected(), disabled: isMutationBlocked || !selectedLegs.some((leg) => leg.linkType || leg.linkedRecordId) },
                  { label: 'Xuất Excel', icon: 'download', onSelect: () => void handleExport(), disabled: isMutationBlocked || !season || legs.length === 0 },
                ]}
              />
              <div className="relative">
                <button
                  onClick={() => setIsUndoOpen(!isUndoOpen)}
                  disabled={hasDraftChanges || modHistory.length === 0 || isMutationBlocked}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">{isUndoing ? 'sync' : 'undo'}</span>
                  Hoàn tác{modHistory.length > 0 ? ` (${modHistory.length})` : ''}
                </button>
                {isUndoOpen && modHistory.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setIsUndoOpen(false)} />
                    <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg">
                      <div className="border-b border-surface-variant bg-surface-container-low px-4 py-3">
                        <h3 className="font-label-caps text-label-caps text-on-surface-variant">Lịch sử thay đổi</h3>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {modHistory.map((entry, idx) => (
                          <div key={entry.id} className="flex items-center justify-between border-b border-surface-variant px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-container-low">
                            <div className="mr-3 min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-on-surface">{entry.description}</p>
                              <p className="text-xs text-on-surface-variant">
                                {new Date(entry.timestamp).toLocaleString('vi-VN')} - {countHistoryEntryLegs(entry)} chặng
                              </p>
                            </div>
                            <button
                              onClick={() => handleUndo(entry)}
                              disabled={isMutationBlocked}
                              className="flex-shrink-0 rounded-lg bg-error-container px-3 py-1.5 text-xs font-medium text-on-error-container transition-colors hover:bg-error/20 disabled:opacity-50"
                            >
                              {idx === 0 ? 'Hoàn tác' : 'Khôi phục về đây'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        />

        {/* Main Canvas - Split View */}
        <main className="flex-1 overflow-hidden p-lg bg-surface flex gap-lg">
          
          {/* Left Panel: Flight Info Card */}
          <div className="w-[380px] shrink-0 flex flex-col gap-0 bg-surface-container-lowest rounded-xl border border-surface-variant shadow-sm overflow-hidden h-full">
            {selectedLegs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant font-body-base p-6 text-center gap-4">
                <span className="material-symbols-outlined text-4xl opacity-50">touch_app</span>
                <p>Chọn một chuyến bay trên lịch</p>
                {newFlightDateSelection && (
                  <button
                    onClick={() => setIsNewFlightOpen(true)}
                    className="flex items-center gap-2 bg-primary text-on-primary font-label-caps text-label-caps px-5 py-2.5 rounded-lg hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    Thêm chuyến bay vào {newFlightDateLabel}
                  </button>
                )}
              </div>
            ) : selectedLegs.length > 1 ? (
              <>
                <div className="bg-primary-container p-6 text-on-primary-container">
                  <h2 className="font-h1 text-h1 mb-1">
                    Đã chọn {selectedLegs.length} chuyến bay
                  </h2>
                  <p className="font-body-sm opacity-80">Sẵn sàng chỉnh sửa hàng loạt</p>
                </div>
                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                  {selectedLegs.map(leg => (
                     <div key={leg.id} className="p-3 bg-surface-container-low rounded border border-surface-variant flex justify-between items-center">
                        <div>
                          <span className="font-medium text-on-surface">{leg.flightNumber}</span>
                          <span className="text-sm text-on-surface-variant ml-2">{leg.date}</span>
                        </div>
                        <span className="font-data-tabular text-on-surface">{leg.schedule}</span>
                     </div>
                  ))}
                </div>
                <div className="p-4 border-t border-surface-variant bg-surface-container-low flex gap-3">
                  <button onClick={handleEditFlight} disabled={isMutationBlocked} className="flex-1 bg-primary text-on-primary font-label-caps text-label-caps py-2 rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                    Sửa chuyến bay đã chọn
                  </button>
                  <button
                    onClick={handleDeleteSelectedLegs}
                    disabled={isMutationBlocked}
                    className="flex-1 border border-error/50 text-error font-label-caps text-label-caps py-2 rounded hover:bg-error-container hover:text-on-error-container transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    Xóa đã chọn
                  </button>
                </div>
              </>
            ) : singleSelectedLeg ? (
              <>
                <div className="bg-primary p-6 text-on-primary">
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-label-caps text-label-caps px-2 py-1 bg-white/20 rounded">
                      {singleSelectedLeg.type === 'A' ? 'ĐẾN' : 'ĐI'}
                    </span>
                    <span className="font-body-sm text-on-primary/80">{singleSelectedLeg.date}</span>
                  </div>
                  <h2 className="font-h1 text-h1 mb-1">
                    {singleSelectedLeg.flightNumber}
                  </h2>
                  <div className="flex items-center gap-4 font-h3 text-h3">
                    <span>{singleSelectedLeg.route?.split('-')[0] || ''}</span>
                    <span className="material-symbols-outlined text-white/70">flight</span>
                    <span>{singleSelectedLeg.route?.split('-')[1] || ''}</span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">TÀU BAY</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.aircraft || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">PHÂN LOẠI</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.category || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">GIỜ BAY</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.schedule || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">LIÊN DANH</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.codeShares || '—'}</span>
                    </div>
                  </div>

                  {linkedLeg && (
                    <div className="border-t border-surface-variant pt-6">
                      <h3 className="font-h3 text-h3 text-on-surface mb-3 flex items-center gap-2">
                         <span className="material-symbols-outlined text-[18px]">sync_alt</span>
                         Chuyến bay liên kết
                      </h3>
                      <div className="bg-surface-container p-4 rounded-lg border border-surface-variant">
                        <div className="flex justify-between items-center mb-2">
                           <span className="font-medium text-primary">{linkedLeg.flightNumber}</span>
                           <span className="text-xs font-label-caps bg-surface-variant px-1 rounded">{linkedLeg.type === 'A' ? 'ĐẾN' : 'ĐI'}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                           <span className="text-on-surface-variant">{linkedLeg.route}</span>
                           <span className="font-data-tabular text-on-surface">{formatLinkedFlightTime(linkedLeg.schedule, singleSelectedLeg.linkType, linkedLeg.type)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-4 border-t border-surface-variant bg-surface-container-low flex flex-col gap-3">
                  <button onClick={handleEditFlight} disabled={isMutationBlocked} className="w-full bg-primary text-on-primary font-label-caps text-label-caps py-2 rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                    Sửa chuyến bay này
                  </button>
                  <button onClick={handleEditSchedule} disabled={isMutationBlocked} className="w-full border border-outline text-on-surface font-label-caps text-label-caps py-2 rounded hover:bg-surface-variant transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
                    <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
                    Sửa toàn bộ lịch
                  </button>
                  <button
                    onClick={handleDeleteSelectedLegs}
                    disabled={isMutationBlocked}
                    className="w-full border border-error/50 text-error font-label-caps text-label-caps py-2 rounded hover:bg-error-container hover:text-on-error-container transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    Xóa đã chọn
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {/* Right Panel: Calendar Grid */}
          <div className="flex-1 flex flex-col bg-surface-container-lowest rounded-xl border border-surface-variant shadow-sm overflow-hidden h-full">
            {/* Calendar Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-variant bg-surface-container-lowest sticky top-0 z-20">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-label-caps text-on-surface-variant">Từ</label>
                  <input 
                    type="date" 
                    value={fromDate} 
                    onChange={e => setFromDate(e.target.value)} 
                    className="bg-surface-container border border-outline-variant rounded p-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-label-caps text-on-surface-variant">Đến</label>
                  <input 
                    type="date" 
                    value={toDate} 
                    onChange={e => setToDate(e.target.value)} 
                    className="bg-surface-container border border-outline-variant rounded p-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-100 border border-blue-300 rounded-sm"></span> Đến</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-100 border border-emerald-300 rounded-sm"></span> Đi</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 border border-outline border-dashed rounded-sm"></span> Đơn lẻ</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 border border-outline border-solid rounded-sm"></span> Cặp chuyến</div>
              </div>
            </div>
            {syncProgress && (
              <div className="px-6 py-2 border-b border-surface-variant bg-surface-container-low text-sm text-on-surface-variant">
                {syncProgress}
              </div>
            )}

            {/* Calendar Grid */}
            <div ref={calendarScrollRef} className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-7 border-b border-surface-variant bg-surface-container-low sticky top-0 z-10">
                {DAYS_OF_WEEK.map((day) => (
                  <div key={day} className="py-2 text-center font-label-caps text-label-caps text-on-surface-variant border-r border-surface-variant last:border-0">
                    {day}
                  </div>
                ))}
              </div>
              
              <div className="grid grid-cols-7 auto-rows-[minmax(120px,1fr)]">
                {calendarDays.map((dateObj, i) => {
                  if (!dateObj) {
                    return <div key={`empty-${i}`} className="border-r border-b border-surface-variant bg-surface-container-low/30 min-h-[120px]" />;
                  }

                  const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                  const dayLegs = legsByDate.get(dateStr) || [];
                  const isToday = new Date().toDateString() === dateObj.toDateString();
                  const isInSelection = isCellInSelection(dateStr);
                  const isFirstOfMonth = dateObj.getDate() === 1;
                  const selectedDayLegsCount = dayLegs.filter(leg => selectedLegIds.has(leg.id)).length;
                  const isDayFullySelected = dayLegs.length > 0 && selectedDayLegsCount === dayLegs.length;
                  const isDayPartiallySelected = selectedDayLegsCount > 0 && selectedDayLegsCount < dayLegs.length;
                  const isSweepTarget = sweepSelectedDates.includes(dateStr);
                  const isSelectedCell = isInSelection || isSweepTarget || isDayFullySelected;
                  const selectionAttr = isDayFullySelected ? 'full' : isDayPartiallySelected ? 'partial' : isSweepTarget ? 'full' : 'none';
                  const MONTH_ABBR = ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6', 'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'];

                  return (
                    <div 
                      key={dateStr}
                      data-date={dateStr}
                      data-selection={selectionAttr}
                      aria-selected={isDayFullySelected || isSweepTarget ? 'true' : isDayPartiallySelected ? 'false' : undefined}
                      aria-label={isDayPartiallySelected ? `${dateStr} đã chọn một phần` : undefined}
                      className={`border-r border-b border-surface-variant p-2 flex flex-col gap-1 min-h-[120px] transition-colors select-none ${
                        isFirstOfMonth ? 'border-l-4 border-l-primary' : ''
                      } ${
                        isToday && !isSelectedCell && !isDayPartiallySelected ? 'bg-primary-fixed/20' : ''
                      } ${
                        isInSelection ? 'bg-primary/10 border-primary' : ''
                      } ${
                        isDayFullySelected || isSweepTarget ? 'bg-amber-50 dark:bg-amber-900/20' : ''
                      } ${
                        isDayPartiallySelected ? 'bg-amber-50/50 dark:bg-amber-900/10 border-amber-300 border-dashed' : ''
                      } ${
                        !isSelectedCell && !isDayPartiallySelected ? 'hover:bg-surface-container-low/50' : ''
                      }`}
                      onMouseDown={(e) => handleMouseDownCell(e, dateStr)}
                      onMouseEnter={() => handleMouseEnterCell(dateStr)}
                      onMouseUp={handleMouseUpCell}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, dateStr)}
                      onClick={(e) => {
                        if (suppressNextCellClickRef.current) {
                          suppressNextCellClickRef.current = false;
                          e.preventDefault();
                          return;
                        }
                        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
                          e.preventDefault();
                          setDateAnchor(dateStr);
                          setSelectedDate(dateStr);
                          const newSelectedLegIds = new Set(selectedLegIds);
                          if (dayLegs.length > 0) {
                            if (isDayFullySelected) {
                              dayLegs.forEach(leg => newSelectedLegIds.delete(leg.id));
                              setSweepSelectedDates(prev => prev.filter(d => d !== dateStr));
                            } else {
                              dayLegs.forEach(leg => newSelectedLegIds.add(leg.id));
                              setSweepSelectedDates(prev => prev.includes(dateStr) ? prev : [...prev, dateStr]);
                            }
                            setSelectedLegIds(newSelectedLegIds);
                          } else {
                            setSweepSelectedDates(prev =>
                              prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr]
                            );
                          }
                        } else if (e.shiftKey && dateAnchor) {
                          e.preventDefault();
                          const startT = new Date(dateAnchor).getTime();
                          const endT = new Date(dateStr).getTime();
                          const minT = Math.min(startT, endT);
                          const maxT = Math.max(startT, endT);
                          const range: string[] = [];
                          const cur = new Date(minT);
                          while (cur.getTime() <= maxT) {
                            range.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
                            cur.setDate(cur.getDate() + 1);
                          }
                          const rangeSet = new Set(range);
                          const newSelectedLegIds = new Set(selectedLegIds);
                          legs.forEach(leg => {
                            if (rangeSet.has(leg.date)) newSelectedLegIds.add(leg.id);
                          });
                          setSelectedLegIds(newSelectedLegIds);
                          setSweepSelectedDates(prev => {
                            const merged = new Set([...prev, ...range]);
                            return Array.from(merged);
                          });
                          setSelectedDate(dateStr);
                        } else {
                          setDateAnchor(dateStr);
                          setSelectedDate(dateStr);
                          setSweepSelectedDates([dateStr]);
                          const dayLegIds = new Set(dayLegs.map(leg => leg.id));
                          setSelectedLegIds(dayLegIds);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-data-tabular text-xs flex items-center justify-center rounded-full ${isToday ? 'bg-primary text-on-primary px-1.5 py-0.5' : 'text-on-surface-variant'} ${isFirstOfMonth ? 'font-bold' : ''}`}>
                          {dateObj.getDate()}-{MONTH_ABBR[dateObj.getMonth()]}
                        </span>
                        {dayLegs.length > 0 && (
                           <span className="text-xs text-on-surface-variant font-label-caps">{dayLegs.length} chuyến</span>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1.5 overflow-y-auto min-h-[80px] p-1 hide-scrollbar">
                        {dayLegs.map((leg) => {
                          const isSelected = selectedLegIds.has(leg.id);
                          const isArr = leg.type === 'A';
                          const companionKey = `${dateStr}_${leg.id}`;
                          const companion = overnightCompanions.get(companionKey);
                          return (
                            <div
                              key={leg.id}
                              className="flex flex-col gap-0.5"
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              <div
                                draggable
                                data-flight-id={leg.id}
                                data-date={leg.date}
                                aria-selected={isSelected}
                                onDragStart={(e) => handleDragStart(e, leg)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDateAnchor(leg.date);
                                  setSelectedDate(leg.date);
                                  if (e.ctrlKey || e.metaKey) {
                                    const newSet = new Set(selectedLegIds);
                                    if (newSet.has(leg.id)) newSet.delete(leg.id);
                                    else newSet.add(leg.id);
                                    setSelectedLegIds(newSet);
                                  } else {
                                    setSelectedLegIds(new Set([leg.id]));
                                    setSweepSelectedDates([leg.date]);
                                  }
                                }}
                                className={`cursor-pointer text-left px-2 py-1.5 rounded text-xs font-data-tabular border ${!leg.linkId ? 'border-dashed' : 'border-solid'} ${
                                  isArr 
                                    ? 'bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800' 
                                    : 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-800'
                                } ${
                                  isSelected ? 'ring-2 ring-primary ring-offset-1 dark:ring-offset-slate-900' : ''
                                }`}
                              >
                                <div className="flex justify-between items-center">
                                   <span className="font-bold">{leg.schedule}</span>
                                   <span className="opacity-70 truncate ml-1">{leg.flightNumber}</span>
                                </div>
                                <div className="flex justify-between items-center mt-0.5">
                                   <span className="opacity-70 truncate">{leg.route}</span>
                                   <span className="opacity-70">{leg.aircraft}</span>
                                </div>
                              </div>
                              {companion && (
                                <div className={`text-left px-2 py-1 rounded text-[10px] font-data-tabular border border-dashed opacity-75 ${
                                  companion.type === 'A'
                                    ? 'bg-blue-50/70 text-blue-800 border-blue-300'
                                    : 'bg-emerald-50/70 text-emerald-800 border-emerald-300'
                                }`}>
                                  <div className="flex justify-between items-center">
                                    <span className="font-semibold">{companion.schedule}</span>
                                    <span className="opacity-70 truncate ml-1">{companion.flightNumber}</span>
                                  </div>
                                  {(() => {
                                    const visibleStart = fromDate || targetDateFrom || null;
                                    const visibleEnd = toDate || targetDateTo || null;
                                    const isOutside = Boolean(
                                      (visibleStart && companion.date < visibleStart) ||
                                      (visibleEnd && companion.date > visibleEnd)
                                    );
                                    if (isOutside || companion.date !== dateStr) {
                                      return (
                                        <div className="text-[9px] text-amber-700 dark:text-amber-300 mt-0.5 font-medium">
                                          {isOutside ? `Ngoài phạm vi hiển thị (${companion.date})` : companion.date}
                                        </div>
                                      );
                                    }
                                    return null;
                                  })()}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          
        </main>

        <EditModal 
          isOpen={isEditModalOpen} 
          onClose={() => setIsEditModalOpen(false)} 
          title={editMode === 'schedule' ? 'Chỉnh sửa toàn bộ lịch' : 'Chỉnh sửa chuyến bay đã chọn'}
          targetLegs={targetLegsForEdit} 
          onNext={handleEditNext} 
        />

        {isLinkModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setIsLinkModalOpen(false)}>
            <div className="bg-surface-container-lowest rounded-xl shadow-2xl w-[520px] max-h-[80vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-surface-variant flex items-center justify-between">
                <h2 className="font-h3 text-h3 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-tertiary">link</span>
                  Liên kết chặng đã chọn
                </h2>
                <button onClick={() => setIsLinkModalOpen(false)} className="p-1 rounded-full hover:bg-surface-container-high transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="px-6 py-4 overflow-y-auto max-h-[420px] flex flex-col gap-2">
                {linkCandidates.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">Không tìm thấy chuyến bay đối ứng phù hợp chưa liên kết cho giai đoạn đã chọn.</p>
                ) : linkCandidates.map((candidate) => (
                  <LinkCandidateItem
                    key={candidate.key}
                    candidate={candidate}
                    onApply={handleApplyLinkCandidate}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
        
        <ConfirmModal 
          isOpen={isConfirmModalOpen} 
          onClose={() => setIsConfirmModalOpen(false)} 
          proposedMods={proposedMods} 
          recordsById={confirmRecordsById}
          nativeChangeCount={proposedMods.length}
          fromDate={fromDate || targetDateFrom || null}
          toDate={toDate || targetDateTo || null}
          onConfirm={handleAddToDraft}
          isSaving={isSaving} 
          confirmLabel="LƯU VÀO BẢN NHÁP"
        />

        <NewFlightModal
          isOpen={isNewFlightOpen}
          onClose={() => setIsNewFlightOpen(false)}
          mode="detailed"
          prefill={null}
          prefillLinked={null}
          prefillDateSelection={newFlightDateSelection}
          onSubmitDetailed={(mods) => {
            setProposedMods(mods);
            setIsConfirmModalOpen(true);
          }}
        />
        {season && isSeasonalPlanningV1Enabled() && (
          <SeasonalPublishModal
            isOpen={isPublishModalOpen}
            seasonId={season.id}
            seasonCode={season.seasonCode || season.code || ''}
            onClose={() => setIsPublishModalOpen(false)}
          />
        )}
        {season && isSeasonalPlanningV1Enabled() && (
          <SeasonalVersionHistoryModal
            isOpen={isHistoryModalOpen}
            seasonId={season.id}
            seasonCode={season.seasonCode || season.code || ''}
            onClose={() => setIsHistoryModalOpen(false)}
            isRestricted={
              isMutationBlocked ||
              currentMods.size > 0
            }
            restrictedReason={
              syncInProgress
                ? 'Đang đồng bộ dữ liệu'
                : (isSaving && !isRestoringDraft) || draftSaveState.status === 'saving'
                ? 'Đang lưu bản nháp'
                : canonicalReloadError
                ? 'Đang có lỗi nạp lại dữ liệu bản nháp sau khi lưu'
                : draftSaveState.hasUnconfirmedChanges || currentMods.size > 0
                ? 'Có thay đổi chưa lưu trong bản nháp'
                : undefined
            }
            currentDraftRevision={historyDraftTokens.revision}
            currentDraftEpoch={historyDraftTokens.epoch}
            onBeginRestore={handleBeginRestore}
            onFinishRestore={handleFinishRestore}
            onDraftRestored={handleDraftRestored}
          />
        )}
        {dialogNode}
      </div>
    </div>
  );
}

export default function DetailedPage() {
  return (
    <Suspense fallback={
      <LoadingStatusPanel
        progress={buildLoadProgress('Đang tải lịch chi tiết...', 20, 'Chuẩn bị dữ liệu tuyến')}
        mode="fullscreen"
      />
    }>
      <DetailedScheduleContent />
    </Suspense>
  );
}
