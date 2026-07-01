'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  getSeasons,
  loadSeasonWorkspaceWindow,
} from '@/lib/remoteStore';
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
  buildFlightRecordHistoryEntry,
  buildDetailedScheduleQueryWindow,
  buildDetailedTransferModifications,
  buildOvernightCompanionMap,
  buildSpatialCalendarDateSelection,
  mergeCalendarDateSelections,
  countHistoryEntryLegs,
  formatLinkedFlightTime,
  filterDetailedLegsForView,
  revertFlightRecordHistoryList,
  revertModificationHistoryMap,
} from '@/lib/detailedScheduleState';
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
import { saveWorkbookAsXlsx } from '@/lib/exportSave';
import type { Season, FlightLeg, FlightModification, ModHistoryEntry, FlightRecord } from '@/lib/types';

interface DetailedScheduleDraftState {
  baseRecords: FlightRecord[];
  baseModifications: Map<string, FlightModification>;
  modifications: FlightModification[];
}

/** Overnight companion leg shown alongside the primary flight in the calendar */
interface OvernightCompanion {
  flightNumber: string;
  schedule: string; // time with +1 or -1 suffix
  route: string;
  aircraft: string;
  type: 'A' | 'D';
  linkId: string;
}
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
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncGuard,
} from '../components/SeasonSyncProvider';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';
import { queryNativeScheduleWindow, runNativeScheduleMutation } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { SERVER_AUTHORITATIVE_MODE } from '@/lib/serverAuthoritativeMode';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';

const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
    buildLoadProgress('Loading detailed schedule...', 10, 'Preparing calendar')
  );

  // Calendar State
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  
  // Selection State
  const [selectedLegIds, setSelectedLegIds] = useState<Set<string>>(new Set());
  const [isMultiSelect, setIsMultiSelect] = useState(false);

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

  // Undo History State
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [currentMods, setCurrentMods] = useState<Map<string, FlightModification>>(new Map());
  const [draftState, setDraftState] = useState<DetailedScheduleDraftState | null>(null);
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
  const fetchProgress = fetchingServerData ? 'Fetching server data' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const hasDraftChanges = (draftState?.modifications.length ?? 0) > 0;
  const currentDetailedWindow = buildDetailedScheduleQueryWindow({
    dateFrom: targetDateFrom || fromDate || null,
    dateTo: targetDateTo || toDate || null,
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
    return `${newFlightDates.length} dates`;
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
    setOvernightCompanions(
      targetArrFlight || targetDepFlight
        ? buildOvernightCompanionMap(finalLegs, finalAllLegs)
        : new Map()
    );
    setSelectedLegIds((prev) => {
      if (!options.preserveSelection) return new Set();
      const visibleIds = new Set(finalLegs.map((leg) => leg.id));
      return new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
    });
  }, [fromDate, targetArrFlight, targetDateFrom, targetDateTo, targetDepFlight, toDate]);

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

  const refreshDetailedWindow = useCallback(async (options: { preserveSelection?: boolean } = {}) => {
    if (!season?.id) return null;
    if (hasDraftChanges) return null;
    const queryWindow = buildDetailedScheduleQueryWindow({
      dateFrom: targetDateFrom || fromDate || null,
      dateTo: targetDateTo || toDate || null,
      targetArrFlight,
      targetDepFlight,
    });
    const windowKey = buildDetailedWindowKey(queryWindow);
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
    return snapshot;
  }, [fromDate, hasDraftChanges, refreshDetailedState, season, targetArrFlight, targetDateFrom, targetDateTo, targetDepFlight, toDate]);

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
  }, [refreshDetailedState, season]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'detailed',
    onRefresh: async () => {
      await refreshDetailedWindow({ preserveSelection: true });
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

  const noOpModificationForRecord = useCallback((record: FlightRecord): FlightModification => ({
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
  }), []);

  interface DetailedLinkCandidate {
    key: string;
    label: string;
    linkType: 'overnight' | 'sameday';
    arrIds: string[];
    depIds: string[];
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
    if (!season || syncInProgress) return;
    const ids = selectedLegs.filter((leg) => leg.linkType || leg.linkedRecordId).map((leg) => leg.id);
    if (ids.length === 0) return;
    const shouldUnlink = await showConfirm({
      title: 'Unlink Selected Flights',
      message: `Unlink ${ids.length} selected linked flight occurrence(s)?`,
      tone: 'warning',
      confirmLabel: 'Unlink',
    });
    if (!shouldUnlink) return;

    try {
      const result = unlinkFlightRecords(flightRecords, ids);
      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Unlinked ${result.updatedRecords.length} flight occurrence(s)`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      const nativeSyncMeta = await runNativeScheduleMutation(
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
          : undefined
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
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
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: historyEntry?.description ?? `Unlinked ${result.updatedRecords.length} flight occurrence(s)`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
    } catch (err) {
      void showAlert({ title: 'Unlink Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [currentMods, flightRecords, modHistory, publishDetailedWorkspaceChange, refreshDetailedState, season, selectedLegs, showAlert, showConfirm, syncInProgress]);

  const handleApplyLinkCandidate = useCallback(async (candidate: DetailedLinkCandidate) => {
    if (!season || syncInProgress) return;
    try {
      const result = linkFlightRecordPairs(flightRecords, candidate.arrIds, candidate.depIds, candidate.linkType);
      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Linked ${result.updatedRecords.length} ${candidate.linkType} flight occurrence(s)`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      const nativeSyncMeta = await runNativeScheduleMutation(
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
          : undefined
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
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
      setIsLinkModalOpen(false);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'detailed',
        operation: historyEntry?.description ?? `Linked ${result.updatedRecords.length} ${candidate.linkType} flight occurrence(s)`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
    } catch (err) {
      void showAlert({ title: 'Link Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [currentMods, flightRecords, modHistory, publishDetailedWorkspaceChange, refreshDetailedState, season, showAlert, syncInProgress]);

  const handleEditNext = useCallback(async (mods: FlightModification[]) => {
    let finalMods = mods;
    const deletedIds = mods.filter((mod) => mod.action === 'deleted').map((mod) => mod.legId);
    if (deletedIds.length > 0) {
      const deletionTargets = resolveLinkedDeletionTargets(allLegs, deletedIds);
      if (deletionTargets.hasActiveCounterpart) {
        const choice = await showChoice({
          title: 'Delete Linked Flight Pair',
          message: `The selected deletion affects ${deletionTargets.selectedIds.length} linked occurrence(s) with ${deletionTargets.counterpartIds.length} active counterpart occurrence(s).\n\nChoose whether to delete the full turnaround pair or only the selected leg.`,
          tone: 'warning',
          choices: [
            { value: 'pair', label: `Delete Entire Flight Pair (${deletionTargets.pairIds.length})`, tone: 'warning' },
            { value: 'selected', label: `Delete Selected Leg Only (${deletionTargets.selectedIds.length})` },
            { value: 'cancel', label: 'Cancel' },
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
  }, [allLegs, showChoice]);

  const handleDeleteSelectedLegs = useCallback(() => {
    if (
      !season ||
      syncInProgress ||
      isSaving ||
      isUndoing ||
      isEditModalOpen ||
      isConfirmModalOpen ||
      selectedLegs.length === 0
    ) {
      return;
    }
    const deleteMods = selectedLegs.map((leg) => ({ legId: leg.id, action: 'deleted' as const }));
    void handleEditNext(deleteMods);
  }, [handleEditNext, isConfirmModalOpen, isEditModalOpen, isSaving, isUndoing, season, selectedLegs, syncInProgress]);

  const handleAddToDraft = async () => {
    if (!season) return;
    if (proposedMods.length === 0) {
      setIsConfirmModalOpen(false);
      return;
    }
    setIsSaving(true);
    try {
      const addedMods = proposedMods.filter((m) => m.action === 'added');
      const regularMods = proposedMods.filter((m) => m.action !== 'added');
      const addedRecords = buildCanonicalAddedFlightRecords(addedMods);
      if (addedRecords.length !== addedMods.length) {
        throw new Error('Added flight payload is missing leg data.');
      }
      assertNoDuplicateFlightNumbersForEffectiveRecords(
        flightRecords,
        currentMods,
        addedRecords,
        regularMods
      );
      const addedRecordIds = new Set(addedRecords.map((record) => record.id));
      const nextRecords = [
        ...flightRecords.filter((record) => !addedRecordIds.has(record.id)),
        ...addedRecords,
      ];
      const nextMods = applyModificationBatch(currentMods, regularMods);
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
      setDraftState({
        ...baseDraft,
        modifications: [...baseDraft.modifications, ...proposedMods],
      });
      setProposedMods([]);
      setIsConfirmModalOpen(false);
    } catch (err) {
      console.error(err);
      void showAlert({ title: 'Draft Failed', message: (err as Error).message, tone: 'error' });
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
    setDraftState(null);
    setProposedMods([]);
    setIsConfirmModalOpen(false);
  }, [draftState, refreshDetailedState, season]);

  const commitDraftBeforeSave = useCallback(async () => {
    if (!season || !draftState || isSaving) return;
    const baseRecordIds = new Set(draftState.baseRecords.map((record) => record.id));
    const draftTargetIds = Array.from(new Set(draftState.modifications.map((mod) => mod.legId)));
    const addedRecords = flightRecords
      .filter((record) => !baseRecordIds.has(record.id) && currentMods.get(record.id)?.action !== 'deleted')
      .map((record) => applyModificationToAddedRecord(record, currentMods.get(record.id)));
    const addedIds = new Set(addedRecords.map((record) => record.id));
    const regularMods = draftTargetIds
      .filter((id) => baseRecordIds.has(id) && !addedIds.has(id))
      .map((id) => currentMods.get(id))
      .filter((mod): mod is FlightModification => Boolean(mod));
    const targetRecordIds = [...addedRecords.map((record) => record.id), ...regularMods.map((mod) => mod.legId)];

    if (targetRecordIds.length === 0) {
      handleDiscardDraft();
      return;
    }

    const delCount = regularMods.filter((mod) => mod.action === 'deleted').length;
    const modCount = regularMods.filter((mod) => mod.action === 'modified').length;
    const addCount = addedRecords.length;
    const parts: string[] = [];
    if (delCount > 0) parts.push(`Deleted ${delCount}`);
    if (modCount > 0) parts.push(`Modified ${modCount}`);
    if (addCount > 0) parts.push(`Added ${addCount}`);
    const description = `${parts.join(', ')} flight(s)`;
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
      const commitSeq = ++detailedCommitSeqRef.current;
      const syncMeta = await runNativeScheduleMutation(season.id, addedRecords, [], regularMods, historyEntry);
      if (!syncMeta) throw new Error('Native schedule mutation is unavailable.');
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
    refreshDetailedWindow,
    season,
  ]);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed', {
    blocked: isSaving || isUndoing,
    reason: isSaving ? 'Saving detailed schedule changes' : isUndoing ? 'Undoing detailed schedule changes' : undefined,
    beforeSync: commitDraftBeforeSave,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
    quiet: true,
    blockingUi: false,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'detailed-draft', {
    blocked: false,
    quiet: true,
    blockingUi: false,
  });

  const handleUndo = async (targetEntry: ModHistoryEntry) => {
    if (!season || syncInProgress) return;
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
      const undoDeletedIds = new Set<string>();
      const undoMods = new Map<string, FlightModification>();
      for (const entry of entriesToUndo) {
        for (const change of entry.recordChanges ?? []) {
          if (change.previousRecord) {
            undoRecords.set(change.recordId, change.previousRecord);
            undoDeletedIds.delete(change.recordId);
          } else if (currentRecordsById.has(change.recordId)) {
            undoRecords.delete(change.recordId);
            undoDeletedIds.add(change.recordId);
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
        syncMeta = await runNativeScheduleMutation(
          season.id,
          Array.from(undoRecords.values()),
          Array.from(undoDeletedIds),
          Array.from(undoMods.values()),
          {
            id: `LOCAL_UNDO_${undoTimestamp}`,
            timestamp: undoTimestamp,
            description: `Undid ${targetEntry.description}`,
          }
        );
        if (!syncMeta) throw new Error('Native schedule mutation is unavailable.');
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
        operation: `Undid ${targetEntry.description}`,
        beforeRecords: flightRecords,
        afterRecords: nextRecords,
        beforeModifications: currentMods,
        afterModifications: nextMods,
        targetRecordIds: affectedIds,
      }));
    } catch (err) {
      console.error(err);
      void showAlert({ title: 'Undo Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setIsUndoing(false);
    }
  };

  const handleSync = useCallback(async () => {
    if (!season || syncInProgress) return;
    try {
      const result = await syncNow();
      void showAlert({
        title: result.status === 'synced' ? 'Save Complete' : 'Save Failed',
        message: result.message ?? 'No pending local changes to save.',
        tone: result.status === 'synced' ? 'success' : 'error',
      });
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
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
    setLoadProgress(buildLoadProgress('Loading server workspace', 35, season.seasonCode));
    try {
      const serverWindow = await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: queryWindow.dateFrom,
        dateTo: queryWindow.dateTo,
        resourceType: 'schedule',
        limit: 100000,
      });
      if (!serverWindow) throw new Error('Server detailed schedule window is unavailable.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== windowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = windowKey;
      setLoadProgress(buildLoadProgress('Rendering calendar', 80, `${serverWindow.records.length} records`));
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
      const message = err instanceof Error && err.message ? err.message : 'Could not fetch detailed schedule data from the server.';
      if (!hasRouteDataLoaded) setLoadError(message);
      void showAlert({ title: 'Fetch data failed', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [
    fetchingServerData,
    fromDate,
    hasDraftChanges,
    refreshDetailedState,
    season,
    showAlert,
    syncInProgress,
    targetArrFlight,
    targetDateFrom,
    targetDateTo,
    targetDepFlight,
    toDate,
  ]);

  const handleSeasonalNavigation = () => {
    if (season && typeof window !== 'undefined') {
      sessionStorage.setItem('activeSeasonId', season.id);
    }
    router.push('/seasonal');
  };

  const handleShowKeyboardShortcuts = () => {
    void showAlert({
      title: 'Keyboard Shortcuts',
      message: [
        'Ctrl+C = Copy selected flight',
        'Ctrl+V = Paste copied flight to selected day(s)',
        'Ctrl+A = Select all visible days and flights',
        'Shift+Click = Select a date range',
      ].join('\n'),
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Resolving schedule filters', 15, 'Preparing detailed calendar'));
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
        setLoadProgress(buildLoadProgress('Loading seasons', 25, activeSeasonId));
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

        const queryWindow = buildDetailedScheduleQueryWindow({
          dateFrom: activeFrom || null,
          dateTo: activeTo || null,
          targetArrFlight: activeArr,
          targetDepFlight: activeDep,
        });
        const windowKey = buildDetailedWindowKey(queryWindow);
        const cachedWindow = readCachedWorkspaceWindow(
          useSeasonWorkspaceStore.getState().workspaces[found.id],
          windowKey
        );
        if (cachedWindow?.syncMeta) {
          loadedWindowKeyRef.current = windowKey;
          setFlightRecords(cachedWindow.records);
          setCurrentMods(cachedWindow.modifications);
          setSyncSummary({
            pendingCount: cachedWindow.syncMeta.pendingCount,
            lastLocalChangeAt: cachedWindow.syncMeta.lastLocalChangeAt,
          });
          refreshDetailedState(cachedWindow.records, cachedWindow.modifications, { preserveSelection: true });
          return;
        }

        setLoadProgress(buildLoadProgress('Loading server workspace', 35, found.seasonCode));
        const serverWindow = await loadSeasonWorkspaceWindow({
          seasonId: found.id,
          dateFrom: queryWindow.dateFrom,
          dateTo: queryWindow.dateTo,
          resourceType: 'schedule',
          limit: 100000,
        }).catch((error) => {
          if (SERVER_AUTHORITATIVE_MODE) throw error;
          console.warn('Server detailed schedule window unavailable, falling back to native SQLite', error);
          return null;
        });
        if (cancelled) return;
        if (serverWindow) {
          loadedWindowKeyRef.current = windowKey;
          const canonicalRecords = serverWindow.records;
          const mods = serverWindow.modifications;
          setLoadProgress(buildLoadProgress(
            'Rendering calendar',
            80,
            `${canonicalRecords.length} records`
          ));
          setSyncSummary({
            pendingCount: serverWindow.syncMeta.pendingCount,
            lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
          });
          setLoadProgress(buildLoadProgress('Rendering calendar', 95, 'Applying filters'));
          setFlightRecords(canonicalRecords);

          const allSeasonLegs = flightRecordsToLegs(canonicalRecords);
          const expanded = filterDetailedLegsForView(allSeasonLegs, activeArr, activeDep, activeFrom, activeTo);
          if (activeArr || activeDep) {
            const companionMap = new Map<string, OvernightCompanion>();
            for (const leg of expanded) {
              if (!leg.linkId) continue;
              const linked = leg.linkedRecordId
                ? allSeasonLegs.find(l => l.id === leg.linkedRecordId)
                : allSeasonLegs.find(l =>
                    l.linkId === leg.linkId &&
                    l.id !== leg.id &&
                    l.type !== leg.type &&
                    (l.pairAnchorDate ?? l.date) === (leg.pairAnchorDate ?? leg.date)
                  );
              if (!linked) continue;
              const key = `${leg.date}_${leg.id}`;
              if (leg.type === 'A') {
                companionMap.set(key, {
                  flightNumber: linked.flightNumber,
                  schedule: leg.linkType === 'overnight' ? `${linked.schedule}+1` : linked.schedule,
                  route: linked.route,
                  aircraft: linked.aircraft,
                  type: 'D',
                  linkId: leg.linkId,
                });
              } else {
                companionMap.set(key, {
                  flightNumber: linked.flightNumber,
                  schedule: leg.linkType === 'overnight' ? `${linked.schedule}-1` : linked.schedule,
                  route: linked.route,
                  aircraft: linked.aircraft,
                  type: 'A',
                  linkId: leg.linkId,
                });
              }
            }
            setOvernightCompanions(companionMap);
          }

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
          const finalAllLegs = applyModificationsToFlightLegs(allSeasonLegs, mods);
          const finalLegs = filterDetailedLegsForView(finalAllLegs, activeArr, activeDep, activeFrom, activeTo);

          setAllLegs(finalAllLegs);
          setLegs(finalLegs);
          setOvernightCompanions(prev => {
            if (activeArr || activeDep) return prev;
            return new Map();
          });
          return;
        }
        if (SERVER_AUTHORITATIVE_MODE) {
          throw new Error('Server detailed schedule window is unavailable.');
        }

        setLoadProgress(buildLoadProgress('Checking local season baseline', 40, found.seasonCode));
        await ensureNativeSeasonBaseline(found);
        if (cancelled) return;
        setLoadProgress(buildLoadProgress('Querying native SQLite fallback', 50, found.seasonCode));
        const result = await queryNativeScheduleWindow({
          seasonId: found.id,
          dateFrom: queryWindow.dateFrom,
          dateTo: queryWindow.dateTo,
          flightNumberFilter: queryWindow.flightNumberFilter,
          limit: 100000,
        });
        if (cancelled) return;
        if (!result) throw new Error('Native detailed schedule query is unavailable.');
        const canonicalRecords = result.records;
        const mods = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        const history: ModHistoryEntry[] = [];
        setLoadProgress(buildLoadProgress(
          'Rendering calendar',
          80,
          `${canonicalRecords.length} records`
        ));
        setSyncSummary({
          pendingCount: result.syncMeta.pendingCount,
          lastLocalChangeAt: result.syncMeta.lastLocalChangeAt,
        });
        setLoadProgress(buildLoadProgress('Rendering calendar', 95, 'Applying filters'));
        setFlightRecords(canonicalRecords);

        const allSeasonLegs = flightRecordsToLegs(canonicalRecords);
        const expanded = filterDetailedLegsForView(allSeasonLegs, activeArr, activeDep, activeFrom, activeTo);
        if (activeArr || activeDep) {

          // Build overnight companion map: for each primary leg, find its linked counterpart
          // Only for TRUE overnight pairs (linked leg on a different date).
          // Same-day turnarounds (ARR+DEP on same date) are normal pairs and excluded.
          const companionMap = new Map<string, OvernightCompanion>();
          for (const leg of expanded) {
            if (!leg.linkId) continue;
            const linked = leg.linkedRecordId
              ? allSeasonLegs.find(l => l.id === leg.linkedRecordId)
              : allSeasonLegs.find(l =>
                  l.linkId === leg.linkId &&
                  l.id !== leg.id &&
                  l.type !== leg.type &&
                  (l.pairAnchorDate ?? l.date) === (leg.pairAnchorDate ?? leg.date)
                );
            if (!linked) continue;
            // Key by the primary leg's date (companion appears on same cell)
            const key = `${leg.date}_${leg.id}`;
            if (leg.type === 'A') {
              // Viewing ARR: companion is the DEP on next day → show with +1
              companionMap.set(key, {
                flightNumber: linked.flightNumber,
                schedule: leg.linkType === 'overnight' ? `${linked.schedule}+1` : linked.schedule,
                route: linked.route,
                aircraft: linked.aircraft,
                type: 'D',
                linkId: leg.linkId,
              });
            } else {
              // Viewing DEP: companion is the ARR on previous day → show with -1
              companionMap.set(key, {
                flightNumber: linked.flightNumber,
                schedule: leg.linkType === 'overnight' ? `${linked.schedule}-1` : linked.schedule,
                route: linked.route,
                aircraft: linked.aircraft,
                type: 'A',
                linkId: leg.linkId,
              });
            }
          }
          setOvernightCompanions(companionMap);
        }

        loadedWindowKeyRef.current = windowKey;
        setCurrentMods(mods); // Store for undo history tracking
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: found.id,
          season: found,
          records: canonicalRecords,
          modifications: mods,
          syncMeta: result.syncMeta,
          windowKey,
        });
        const finalAllLegs = applyModificationsToFlightLegs(allSeasonLegs, mods);
        const finalLegs = filterDetailedLegsForView(finalAllLegs, activeArr, activeDep, activeFrom, activeTo);

        setAllLegs(finalAllLegs);
        setLegs(finalLegs);
        setOvernightCompanions(
          activeArr || activeDep
            ? buildOvernightCompanionMap(finalLegs, finalAllLegs)
            : new Map()
        );

        setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession(history)));

        // Set initial calendar date to the first leg's date if possible
        if (activeFrom) {
          setFromDate(activeFrom);
        } else if (finalLegs.length > 0) {
           const dates = finalLegs.map(l => new Date(l.date).getTime());
           const minD = new Date(Math.min(...dates));
           setFromDate(minD.toISOString().split('T')[0]);
        } else {
          setFromDate('');
        }

        if (activeTo) {
          setToDate(activeTo);
        } else if (finalLegs.length > 0) {
           const dates = finalLegs.map(l => new Date(l.date).getTime());
           const maxD = new Date(Math.max(...dates));
           setToDate(maxD.toISOString().split('T')[0]);
        } else {
          setToDate('');
        }

        if (finalLegs.length > 0) {
          const visibleLegIds = new Set(finalLegs.map((leg) => leg.id));
          setSelectedLegIds((prev) => {
            const preservedVisibleIds = Array.from(prev).filter((id) => visibleLegIds.has(id));
            return preservedVisibleIds.length > 0 ? new Set(preservedVisibleIds) : new Set([finalLegs[0].id]);
          });
        } else {
          setSelectedLegIds(new Set());
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Error loading detailed schedule', err);
          setLoadError(err instanceof Error && err.message ? err.message : 'Could not load detailed schedule data from the server.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetSeasonId, targetArrFlight, targetDepFlight, targetDateFrom, targetDateTo, hasExplicitDetailedFlightSelection, router, showAlert]);

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
      if (
        e.key === 'Delete' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
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
        if (copiedLeg && sweepSelectedDates.length > 0) {
          const newMods: FlightModification[] = [];

          sweepSelectedDates.forEach(targetDate => {
            newMods.push(...buildDetailedTransferModifications({
              sourceLeg: copiedLeg,
              visibleLegs: legs,
              allLegs,
              targetDate,
              mode: 'copy',
            }));
          });

          if (newMods.length > 0) {
            setProposedMods(newMods);
            setIsConfirmModalOpen(true);
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        if (fromDate && toDate) {
          const allDates: string[] = [];
          const cur = new Date(fromDate);
          const end = new Date(toDate);
          while (cur <= end) {
            allDates.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
            cur.setDate(cur.getDate() + 1);
          }
          setSweepSelectedDates(allDates);
          const dateSet = new Set(allDates);
          const visibleLegIds = new Set(legs.filter(l => dateSet.has(l.date)).map(l => l.id));
          setSelectedLegIds(visibleLegIds);
          setIsMultiSelect(true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [singleSelectedLeg, copiedLeg, sweepSelectedDates, legs, allLegs, fromDate, toDate, isRouteActive, handleDeleteSelectedLegs]);

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
      setIsMultiSelect(true);
    }
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
    setSelectionMode('replace');
  };

  const handleDragStart = (e: React.DragEvent, leg: FlightLeg) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ legId: leg.id }));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
  };

  const handleDrop = (e: React.DragEvent, targetDateStr: string) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;
    try {
      const { legId } = JSON.parse(data);
      const draggedLeg = legs.find(l => l.id === legId);
      if (!draggedLeg) return;
      if (draggedLeg.date === targetDateStr) return;

      const isCopy = e.ctrlKey || e.metaKey;
      
      const newMods = buildDetailedTransferModifications({
        sourceLeg: draggedLeg,
        visibleLegs: legs,
        allLegs,
        targetDate: targetDateStr,
        mode: isCopy ? 'copy' : 'move',
      });

      setProposedMods(newMods);
      setIsConfirmModalOpen(true);
    } catch (err) {
      console.error('Drop error', err);
    }
  };

  const handleExport = useCallback(async () => {
    if (!season || legs.length === 0) return;
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
      void showAlert({ title: 'Export Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [season, legs, notifyExportCompleted, showAlert]);

  if (loading) {
    return <LoadingStatusPanel progress={loadProgress} mode="fullscreen" />;
  }

  if (loadError) {
    return (
      <div className="flex h-dvh items-center justify-center bg-surface p-6">
        <div className="max-w-xl rounded-lg border border-error/30 bg-surface-container-lowest p-6 text-center shadow-sm">
          <div className="font-title-sm text-title-sm text-error">Cannot load detailed schedule</div>
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
            <button onClick={handleSeasonalNavigation} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container-high" title="Back to Seasonal Schedule" aria-label="Back to Seasonal Schedule">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
          )}
          title="Detailed Schedule"
          subtitle={season ? `${buildSeasonDisplayLabel(season)}${(targetArrFlight || targetDepFlight) ? ` (Filtered to ${targetArrFlight || ''} ${targetArrFlight && targetDepFlight ? '/' : ''} ${targetDepFlight || ''})` : ''}` : 'No season selected'} 
          statusControls={season && (
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
          draftControls={hasDraftChanges && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900">
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              <span className="text-xs font-semibold">{draftState?.modifications.length ?? 0} draft changes</span>
              <button
                onClick={handleDiscardDraft}
                disabled={isSaving || syncInProgress}
                className="rounded px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          )}
          primaryActions={(
            <>
              <label className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container-high">
                <input
                  type="checkbox"
                  checked={isMultiSelect}
                  onChange={(event) => {
                    setIsMultiSelect(event.target.checked);
                    if (!event.target.checked && selectedLegIds.size > 1) {
                      const first = Array.from(selectedLegIds)[0];
                      setSelectedLegIds(new Set(first ? [first] : []));
                    }
                    if (!event.target.checked) {
                      setSweepSelectedDates([]);
                    }
                  }}
                  className="h-4 w-4 rounded text-primary focus:ring-primary"
                />
                Multi-select
              </label>
              <button
                onClick={() => setIsNewFlightOpen(true)}
                disabled={!newFlightDateSelection || syncInProgress}
                title={newFlightDateSelection ? `Add flights on ${newFlightDateLabel}` : 'Select date cells first'}
                className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                Add Flight
              </button>
              <button
                onClick={handleShowKeyboardShortcuts}
                className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-[18px]">keyboard</span>
                Shortcuts
              </button>
              {copiedLeg && (
                <span className="flex min-h-10 items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-xs font-medium text-amber-800">
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  {copiedLeg.flightNumber}
                  {sweepSelectedDates.length > 0 && (
                    <span className="ml-1 text-amber-600">to {sweepSelectedDates.length} days (Ctrl+V)</span>
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
                  disabled={linkCandidates.length === 0 || syncInProgress}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">link</span>
                  Link
                </button>
                <button
                  onClick={handleUnlinkSelected}
                  disabled={syncInProgress || !selectedLegs.some((leg) => leg.linkType || leg.linkedRecordId)}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">link_off</span>
                  Unlink
                </button>
                <button onClick={handleExport} className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low">
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  Export Excel
                </button>
              </div>
              <HeaderActionMenu
                className="xl:hidden"
                items={[
                  { label: 'Link', icon: 'link', onSelect: () => setIsLinkModalOpen(true), disabled: linkCandidates.length === 0 || syncInProgress },
                  { label: 'Unlink', icon: 'link_off', onSelect: () => void handleUnlinkSelected(), disabled: syncInProgress || !selectedLegs.some((leg) => leg.linkType || leg.linkedRecordId) },
                  { label: 'Export Excel', icon: 'download', onSelect: () => void handleExport() },
                ]}
              />
              <div className="relative">
                <button
                  onClick={() => setIsUndoOpen(!isUndoOpen)}
                  disabled={hasDraftChanges || modHistory.length === 0 || isUndoing}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[18px]">{isUndoing ? 'sync' : 'undo'}</span>
                  Undo{modHistory.length > 0 ? ` (${modHistory.length})` : ''}
                </button>
                {isUndoOpen && modHistory.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setIsUndoOpen(false)} />
                    <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg">
                      <div className="border-b border-surface-variant bg-surface-container-low px-4 py-3">
                        <h3 className="font-label-caps text-label-caps text-on-surface-variant">Change History</h3>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {modHistory.map((entry, idx) => (
                          <div key={entry.id} className="flex items-center justify-between border-b border-surface-variant px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-container-low">
                            <div className="mr-3 min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-on-surface">{entry.description}</p>
                              <p className="text-xs text-on-surface-variant">
                                {new Date(entry.timestamp).toLocaleString()} - {countHistoryEntryLegs(entry)} leg(s)
                              </p>
                            </div>
                            <button
                              onClick={() => handleUndo(entry)}
                              disabled={isUndoing}
                              className="flex-shrink-0 rounded-lg bg-error-container px-3 py-1.5 text-xs font-medium text-on-error-container transition-colors hover:bg-error/20 disabled:opacity-50"
                            >
                              {idx === 0 ? 'Undo' : 'Revert to here'}
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
                <p>Select a flight on the calendar</p>
                {newFlightDateSelection && (
                  <button
                    onClick={() => setIsNewFlightOpen(true)}
                    className="flex items-center gap-2 bg-primary text-on-primary font-label-caps text-label-caps px-5 py-2.5 rounded-lg hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    Add Flight on {newFlightDateLabel}
                  </button>
                )}
              </div>
            ) : selectedLegs.length > 1 ? (
              <>
                <div className="bg-primary-container p-6 text-on-primary-container">
                  <h2 className="font-h1 text-h1 mb-1">
                    Selected {selectedLegs.length} flights
                  </h2>
                  <p className="font-body-sm opacity-80">Ready for batch editing</p>
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
                  <button onClick={handleEditFlight} className="flex-1 bg-primary text-on-primary font-label-caps text-label-caps py-2 rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                    Edit Selected Flights
                  </button>
                  <button
                    onClick={handleDeleteSelectedLegs}
                    disabled={syncInProgress || isSaving || isUndoing}
                    className="flex-1 border border-error/50 text-error font-label-caps text-label-caps py-2 rounded hover:bg-error-container hover:text-on-error-container transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    Delete Selected
                  </button>
                </div>
              </>
            ) : singleSelectedLeg ? (
              <>
                <div className="bg-primary p-6 text-on-primary">
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-label-caps text-label-caps px-2 py-1 bg-white/20 rounded">
                      {singleSelectedLeg.type === 'A' ? 'ARRIVAL' : 'DEPARTURE'}
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
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">AIRCRAFT</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.aircraft || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">CATEGORY</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.category || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">SCHEDULE</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.schedule || '—'}</span>
                    </div>
                    <div>
                      <span className="block font-label-caps text-label-caps text-on-surface-variant mb-1">CODESHARE</span>
                      <span className="font-data-tabular text-data-tabular text-on-surface">{singleSelectedLeg.codeShares || '—'}</span>
                    </div>
                  </div>

                  {linkedLeg && (
                    <div className="border-t border-surface-variant pt-6">
                      <h3 className="font-h3 text-h3 text-on-surface mb-3 flex items-center gap-2">
                         <span className="material-symbols-outlined text-[18px]">sync_alt</span>
                         Linked Flight
                      </h3>
                      <div className="bg-surface-container p-4 rounded-lg border border-surface-variant">
                        <div className="flex justify-between items-center mb-2">
                           <span className="font-medium text-primary">{linkedLeg.flightNumber}</span>
                           <span className="text-xs font-label-caps bg-surface-variant px-1 rounded">{linkedLeg.type === 'A' ? 'ARR' : 'DEP'}</span>
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
                  <button onClick={handleEditFlight} className="w-full bg-primary text-on-primary font-label-caps text-label-caps py-2 rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                    Edit This Flight
                  </button>
                  <button onClick={handleEditSchedule} className="w-full border border-outline text-on-surface font-label-caps text-label-caps py-2 rounded hover:bg-surface-variant transition-colors flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
                    Edit Master Schedule
                  </button>
                  <button
                    onClick={handleDeleteSelectedLegs}
                    disabled={syncInProgress || isSaving || isUndoing}
                    className="w-full border border-error/50 text-error font-label-caps text-label-caps py-2 rounded hover:bg-error-container hover:text-on-error-container transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    Delete Selected
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
                  <label className="text-xs font-label-caps text-on-surface-variant">From</label>
                  <input 
                    type="date" 
                    value={fromDate} 
                    onChange={e => setFromDate(e.target.value)} 
                    className="bg-surface-container border border-outline-variant rounded p-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-label-caps text-on-surface-variant">To</label>
                  <input 
                    type="date" 
                    value={toDate} 
                    onChange={e => setToDate(e.target.value)} 
                    className="bg-surface-container border border-outline-variant rounded p-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-100 border border-blue-300 rounded-sm"></span> ARR</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-100 border border-emerald-300 rounded-sm"></span> DEP</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 border border-outline border-dashed rounded-sm"></span> Single</div>
                <div className="flex items-center gap-1"><span className="w-3 h-3 border border-outline border-solid rounded-sm"></span> Turnaround</div>
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
                  const isSweepTarget = sweepSelectedDates.includes(dateStr);
                  const isSelectedCell = isInSelection || isSweepTarget;
                  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

                  return (
                    <div 
                      key={dateStr} 
                      className={`border-r border-b border-surface-variant p-2 flex flex-col gap-1 min-h-[120px] transition-colors select-none ${isFirstOfMonth ? 'border-l-4 border-l-primary' : ''} ${isToday && !isSelectedCell ? 'bg-primary-fixed/20' : ''} ${isInSelection ? 'bg-primary/10 border-primary' : ''} ${isSweepTarget ? 'bg-amber-50 dark:bg-amber-900/20' : ''} ${!isSelectedCell ? 'hover:bg-surface-container-low/50' : ''}`}
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
                          setSweepSelectedDates(prev =>
                            prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr]
                          );
                          setDateAnchor(dateStr);
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
                          setSweepSelectedDates(prev => {
                            const merged = new Set([...prev, ...range]);
                            return Array.from(merged);
                          });
                        } else {
                          // Plain click on cell: clear all selections and track date for Add Flight
                          setSweepSelectedDates([]);
                          setDateAnchor(null);
                          setSelectedLegIds(new Set());
                          setIsMultiSelect(false);
                          setSelectedDate(dateStr);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-data-tabular text-xs flex items-center justify-center rounded-full ${isToday ? 'bg-primary text-on-primary px-1.5 py-0.5' : 'text-on-surface-variant'} ${isFirstOfMonth ? 'font-bold' : ''}`}>
                          {dateObj.getDate()}-{MONTH_ABBR[dateObj.getMonth()]}
                        </span>
                        {dayLegs.length > 0 && (
                           <span className="text-xs text-on-surface-variant font-label-caps">{dayLegs.length} flights</span>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1.5 overflow-y-auto min-h-[80px] p-1 hide-scrollbar">
                        {dayLegs.map((leg) => {
                          const isSelected = selectedLegIds.has(leg.id);
                          const isArr = leg.type === 'A';
                          const companionKey = `${dateStr}_${leg.id}`;
                          const companion = overnightCompanions.get(companionKey);
                          return (
                            <div key={leg.id} className="flex flex-col gap-0.5">
                              <div
                                draggable
                                onDragStart={(e) => handleDragStart(e, leg)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isMultiSelect) {
                                    const newSet = new Set(selectedLegIds);
                                    if (newSet.has(leg.id)) newSet.delete(leg.id);
                                    else newSet.add(leg.id);
                                    setSelectedLegIds(newSet);
                                  } else {
                                    setSelectedLegIds(new Set([leg.id]));
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
                                <div className={`text-left px-2 py-1 rounded text-[10px] font-data-tabular border border-dashed opacity-60 ${
                                  companion.type === 'A'
                                    ? 'bg-blue-50/50 text-blue-800 border-blue-300'
                                    : 'bg-emerald-50/50 text-emerald-800 border-emerald-300'
                                }`}>
                                  <div className="flex justify-between items-center">
                                    <span className="font-semibold">{companion.schedule}</span>
                                    <span className="opacity-70 truncate ml-1">{companion.flightNumber}</span>
                                  </div>
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
          title={editMode === 'schedule' ? 'Edit Master Schedule' : 'Edit Selected Flights'}
          targetLegs={targetLegsForEdit} 
          onNext={handleEditNext} 
        />

        {isLinkModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setIsLinkModalOpen(false)}>
            <div className="bg-surface-container-lowest rounded-xl shadow-2xl w-[520px] max-h-[80vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-surface-variant flex items-center justify-between">
                <h2 className="font-h3 text-h3 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-tertiary">link</span>
                  Link Selected Phase
                </h2>
                <button onClick={() => setIsLinkModalOpen(false)} className="p-1 rounded-full hover:bg-surface-container-high transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="px-6 py-4 overflow-y-auto max-h-[420px] flex flex-col gap-2">
                {linkCandidates.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">No exact matching unlinked counterpart found for the selected phase.</p>
                ) : linkCandidates.map((candidate) => (
                  <div key={candidate.key} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-surface-variant hover:bg-primary-container/10 transition-colors">
                    <div className="min-w-0">
                      <div className="font-data-tabular text-sm font-semibold text-primary truncate">{candidate.label}</div>
                      <div className="text-xs text-on-surface-variant">
                        {candidate.linkType === 'overnight' ? 'Overnight +1' : 'Same-day'} · {candidate.arrIds.length} pair(s)
                      </div>
                    </div>
                    <button
                      onClick={() => handleApplyLinkCandidate(candidate)}
                      className="shrink-0 px-3 py-1.5 rounded bg-tertiary-container text-on-tertiary-container text-xs font-semibold hover:bg-tertiary-container/80 transition-colors"
                    >
                      Link
                    </button>
                  </div>
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
          onConfirm={handleAddToDraft}
          isSaving={isSaving} 
          confirmLabel="ADD TO DRAFT"
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
        {dialogNode}
      </div>
    </div>
  );
}

export default function DetailedPage() {
  return (
    <Suspense fallback={
      <LoadingStatusPanel
        progress={buildLoadProgress('Loading detailed schedule...', 20, 'Preparing route')}
        mode="fullscreen"
      />
    }>
      <DetailedScheduleContent />
    </Suspense>
  );
}
