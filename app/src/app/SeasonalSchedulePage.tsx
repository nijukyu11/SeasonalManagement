'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { parseSeasonalSchedule, enrichRows } from '@/lib/parser';
import {
  applySeasonalImportRemote,
  findSeasonByCode,
  getSeasons,
  getSeasonalExportSnapshot,
  loadSeasonWorkspaceWindow,
  type RemoteSeasonalImportInput,
  type RemoteSeasonalImportResult,
} from '@/lib/remoteStore';
import { validateFlightLegsForSeasonalExport } from '@/lib/exporter';
import { buildCanonicalSeasonalRows, downloadCanonicalSeasonalExcel } from '@/lib/canonicalSeasonalRows';
import { materializeEffectiveSeasonalLegs } from '@/lib/effectiveSeasonalLegs';
import {
  validateSeasonalExportSelection,
  type SeasonalExportSelection,
} from '@/lib/seasonalExportSelection';
import {
  buildFlightRecordHistoryEntry,
  countHistoryEntryLegs,
  revertFlightRecordHistoryList,
  revertModificationHistoryMap,
} from '@/lib/detailedScheduleState';
import { buildImportProgress, buildLoadProgress, type ImportProgress, type LoadProgress } from '@/lib/importProgress';
import { buildSeasonDisplayLabel, getDirtyImportGuard } from '@/lib/importSeasonRules';
import {
  buildSeasonalImportCommittedRefreshFailure,
  prepareSeasonalImportV2Attempt,
  SeasonalImportV2StatusUnknownError,
} from '@/lib/seasonalImportRpcContract';
import {
  buildSeasonalImportStatusUnknownNotice,
  loadTargetedCommittedImportRefresh,
  resumeSeasonalImportAttemptOnce,
} from '@/lib/seasonalImportRecovery';
import {
  buildSeasonalAvailableRecordIds,
  createSeasonalFileActionController,
  getSeasonalFileActionBlock,
  reconcileSeasonalSelection,
  type SeasonalFileActionInvalidation,
  type SeasonalFileActionOperation,
  type SeasonalMutationOperation,
} from '@/lib/seasonalFileActionGuard';
import { setSeasonalFileActionRuntimeState } from '@/lib/seasonalFileActionRuntimeState';
import {
  getCachedSeasons,
  publishSeasonWorkspaceChanged,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  assertNoDuplicateFlightNumbers,
  findDuplicateFlightNumberViolations,
  flattenRowsToFlightRecords,
  flightRecordsToLegs,
  linkFlightRecordPairs,
  unlinkFlightRecords,
} from '@/lib/atomicSchedule';
import {
  buildSeasonalLinkCandidates,
  buildSeasonalLinkRoute,
  getSeasonalLinkActionState,
  type SeasonalLinkCandidate,
} from '@/lib/seasonalLinkActions';
import { buildSeasonalDisplayGroups } from '@/lib/seasonalDisplayAggregator';
import { matchesSeasonalFlightFilter } from '@/lib/seasonalFlightFilter';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import type { Season, DisplayRow, FlightRecord, FlightLeg, FlightModification, ParsedRow, ModHistoryEntry } from '@/lib/types';
import { withScheduleNotificationPayload } from '@/lib/scheduleNotifications';
import { resolveLinkedDeletionTargets } from '@/lib/pairDeletion';
import { filterUiUndoEntriesForSession, trimUiUndoEntries } from '@/lib/uiUndoMemory';
import { useAppDialog } from './components/AppDialog';
import { useExportNotifications } from './components/ExportNotificationProvider';
import FetchServerUpdatesButton from './components/FetchServerUpdatesButton';
import SyncActionButton from './components/SyncActionButton';
import NewFlightModal from './components/NewFlightModal';
import LoadingStatusPanel from './components/LoadingStatusPanel';
import WorkspacePageHeader from './components/WorkspacePageHeader';
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncGuard,
} from './components/SeasonSyncProvider';
import { useSeasonWorkspaceRefresh } from './hooks/useSeasonWorkspaceRefresh';
import {
  runNativeScheduleMutation,
} from '@/lib/nativeSeasonRepository';

const PAGE_SIZE = 50;
const DAY_LABELS = ['1', '2', '3', '4', '5', '6', '7'];

function buildSeasonalWindowKey(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  flight?: string | null;
  route?: string | null;
}): string {
  return [
    'seasonal',
    input.dateFrom ?? '',
    input.dateTo ?? '',
    input.flight ?? '',
    input.route ?? '',
  ].join(':');
}

function getAffectedIdsFromSeasonalModifications(mods: FlightModification[]): string[] {
  return Array.from(new Set(mods.map((mod) => mod.legId)));
}

interface SeasonalScheduleDraftState {
  baseRows: ParsedRow[];
  baseRecords: FlightRecord[];
  baseModifications: Map<string, FlightModification>;
  records: FlightRecord[];
  modifications: FlightModification[];
}

function describeSeasonalExportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown export error.');
  if (/version|data version/i.test(message)) return `Version: ${message}`;
  if (/snapshot|array|totalCount|truncated|season mismatch/i.test(message)) return `Snapshot: ${message}`;
  return `Server: ${message}`;
}

function countSeasonalDraftChanges(draft: SeasonalScheduleDraftState | null): number {
  return (draft?.records.length ?? 0) + (draft?.modifications.length ?? 0);
}

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {}
  }
  return 'Could not load schedule data from the server.';
}

function buildPatternRowsFromRecords(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>
): ParsedRow[] {
  const canonical = buildCanonicalSeasonalRows({ records, modifications });
  if (!canonical.validation.valid) {
    console.warn('Canonical seasonal pattern validation failed', canonical.diagnostics);
  }
  return canonical.rows;
}

function applyModificationsToLegs(
  legs: FlightLeg[],
  mods: Map<string, FlightModification>,
  includeAdded: boolean
): FlightLeg[] {
  const next = legs.map(leg => {
    const m = mods.get(leg.id);
    if (!m) return leg;
    if (m.action === 'deleted') return { ...leg, action: 'deleted' as const };
    if (m.action === 'modified') return {
      ...leg,
      schedule: m.schedule ?? leg.schedule,
      aircraft: m.aircraft ?? leg.aircraft,
      route: m.route ?? leg.route,
      codeShares: 'codeShares' in m ? m.codeShares ?? null : leg.codeShares,
      pax: 'pax' in m ? m.pax ?? null : leg.pax,
      gate: 'gate' in m ? m.gate ?? null : leg.gate,
      stand: 'stand' in m ? m.stand ?? null : leg.stand,
      counter: 'counter' in m ? m.counter ?? null : leg.counter,
      carousel: 'carousel' in m ? m.carousel ?? null : leg.carousel,
      mct: 'mct' in m ? m.mct ?? null : leg.mct,
      fb: 'fb' in m ? m.fb ?? null : leg.fb,
      lb: 'lb' in m ? m.lb ?? null : leg.lb,
      bhs: 'bhs' in m ? m.bhs ?? null : leg.bhs,
      ghs: 'ghs' in m ? m.ghs ?? null : leg.ghs,
      action: 'modified' as const,
    };
    return leg;
  }).filter(l => l.action !== 'deleted');

  if (includeAdded) {
    mods.forEach(m => {
      if (m.action === 'added' && m.addedLeg) {
        next.push({ ...m.addedLeg, action: 'added' });
      }
    });
  }

  return next;
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

export default function HomePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedWindowKeyRef = useRef<string | null>(null);
  const fetchServerDataRequestRef = useRef(0);
  const fileActionControllerRef = useRef(createSeasonalFileActionController());
  const latestActiveSeasonRef = useRef<Season | null>(null);
  const pendingImportAttemptRef = useRef<RemoteSeasonalImportInput | null>(null);
  const pendingCommittedImportRef = useRef<RemoteSeasonalImportResult | null>(null);
  const latestDraftStateRef = useRef<{
    value: SeasonalScheduleDraftState | null;
    revision: number;
    hasDraftChanges: boolean;
  }>({ value: null, revision: 0, hasDraftChanges: false });
  const latestRouteWindowRef = useRef<{ seasonId: string | null; windowKey: string }>({
    seasonId: null,
    windowKey: '',
  });
  const { dialogNode, showAlert, showConfirm, showChoice } = useAppDialog();
  const { notifyExportCompleted } = useExportNotifications();

  // Data
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [activeSeason, setActiveSeasonState] = useState<Season | null>(null);
  const [displayRows, setDisplayRows] = useState<DisplayRow[]>([]);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());
  const [exportAllSelected, setExportAllSelected] = useState(false);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [draftState, setDraftStateValue] = useState<SeasonalScheduleDraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading seasons...', 10, 'Preparing seasonal schedule')
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null);
  const [pendingImportAttempt, setPendingImportAttemptState] = useState<RemoteSeasonalImportInput | null>(null);
  const [pendingCommittedImport, setPendingCommittedImportState] = useState<RemoteSeasonalImportResult | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isNewFlightOpen, setIsNewFlightOpen] = useState(false);
  const [linkModalGroupKey, setLinkModalGroupKey] = useState<string | null>(null);
  const [linkingCandidateKey, setLinkingCandidateKey] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    lastLocalChangeAt: null,
  });
  const [isUndoOpen, setIsUndoOpen] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [activeFileActionToken, setActiveFileActionToken] = useState<number | null>(null);
  const [activeMutationToken, setActiveMutationToken] = useState<number | null>(null);
  const setPendingImportAttempt = useCallback((attempt: RemoteSeasonalImportInput | null) => {
    pendingImportAttemptRef.current = attempt;
    setPendingImportAttemptState(attempt);
  }, []);
  const setPendingCommittedImport = useCallback((result: RemoteSeasonalImportResult | null) => {
    pendingCommittedImportRef.current = result;
    setPendingCommittedImportState(result);
  }, []);
  const setActiveSeason = useCallback((nextSeason: Season | null) => {
    latestActiveSeasonRef.current = nextSeason;
    setActiveSeasonState(nextSeason);
  }, []);
  const setDraftState = useCallback((nextDraft: SeasonalScheduleDraftState | null) => {
    const latest = latestDraftStateRef.current;
    if (latest.value !== nextDraft) {
      latestDraftStateRef.current = {
        value: nextDraft,
        revision: latest.revision + 1,
        hasDraftChanges: countSeasonalDraftChanges(nextDraft) > 0,
      };
    }
    setDraftStateValue(nextDraft);
  }, []);
  const { status: syncStatus, syncNow } = useSeasonSync(activeSeason?.id, 'seasonal');
  const [fetchingServerData, setFetchingServerData] = useState(false);
  const syncInProgress = syncStatus.status === 'syncing';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' ? syncStatus.message : null);
  const fetchProgress = fetchingServerData ? 'Fetching server data' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const draftChangeCount = countSeasonalDraftChanges(draftState);
  const hasDraftChanges = draftChangeCount > 0;

  useEffect(() => {
    if (!activeSeason?.id) return;
    setSeasonalFileActionRuntimeState(activeSeason.id, {
      hasDraftChanges,
      draftRevision: latestDraftStateRef.current.revision,
    });
  }, [activeSeason?.id, draftState, hasDraftChanges]);
  const seasonalFileActionActive = activeFileActionToken !== null;
  const seasonalMutationActive = activeMutationToken !== null;
  const seasonalImportRecoveryPending = pendingImportAttempt !== null || pendingCommittedImport !== null;
  const seasonalFileActionBusy = loading
    || uploading
    || isExporting
    || syncInProgress
    || fetchingServerData
    || seasonalFileActionActive
    || seasonalMutationActive
    || isNewFlightOpen
    || linkModalGroupKey !== null;

  const beginSeasonalFileAction = useCallback((action: SeasonalFileActionOperation['action']) => {
    const operation = fileActionControllerRef.current.beginFileAction(action, {
      seasonId: latestActiveSeasonRef.current?.id ?? null,
      draftRevision: latestDraftStateRef.current.revision,
    });
    if (operation) setActiveFileActionToken(operation.token);
    return operation;
  }, []);
  const validateSeasonalFileAction = useCallback((operation: SeasonalFileActionOperation) => (
    fileActionControllerRef.current.validateFileAction(operation, {
      seasonId: latestActiveSeasonRef.current?.id ?? null,
      draftRevision: latestDraftStateRef.current.revision,
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
    })
  ), []);
  const finishSeasonalFileAction = useCallback((operation: SeasonalFileActionOperation) => {
    fileActionControllerRef.current.finishFileAction(operation);
    setActiveFileActionToken((current) => current === operation.token ? null : current);
  }, []);
  const beginSeasonalMutation = useCallback(() => {
    const operation = fileActionControllerRef.current.beginMutation();
    if (operation) setActiveMutationToken(operation.token);
    return operation;
  }, []);
  const finishSeasonalMutation = useCallback((operation: SeasonalMutationOperation) => {
    fileActionControllerRef.current.finishMutation(operation);
    setActiveMutationToken((current) => current === operation.token ? null : current);
  }, []);
  const isSeasonalFileActionBusyNow = useCallback(() => (
    seasonalFileActionBusy
    || fileActionControllerRef.current.isFileActionActive()
    || fileActionControllerRef.current.isMutationActive()
  ), [seasonalFileActionBusy]);
  const showSeasonalFileActionInvalidation = useCallback((
    action: SeasonalFileActionOperation['action'],
    invalidation: SeasonalFileActionInvalidation,
  ) => {
    void showAlert({
      title: action === 'import' ? 'Import Interrupted' : 'Cannot Export',
      message: `${invalidation.message} Review the current season and try again.`,
      tone: 'warning',
    });
  }, [showAlert]);

  // Pagination
  const [page, setPage] = useState(0);

  // Column Filters
  const [filters, setFilters] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('seasonalFilters');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {}
      }
    }
    return {
      flight: '',
      type: '',
      route: '',
      aircraft: '',
      time: '',
      dateFrom: '',
      dateTo: ''
    };
  });
  const [debouncedFilters, setDebouncedFilters] = useState(filters);

  useEffect(() => {
    sessionStorage.setItem('seasonalFilters', JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 400);
    return () => clearTimeout(t);
  }, [filters]);

  const hasActiveFilters = useMemo(
    () => Object.values(debouncedFilters).some((value) => String(value ?? '').trim().length > 0),
    [debouncedFilters]
  );
  const currentSeasonalWindowKey = buildSeasonalWindowKey({
    dateFrom: debouncedFilters.dateFrom || null,
    dateTo: debouncedFilters.dateTo || null,
    flight: debouncedFilters.flight || null,
    route: debouncedFilters.route || null,
  });
  useEffect(() => {
    latestRouteWindowRef.current = {
      seasonId: activeSeason?.id ?? null,
      windowKey: currentSeasonalWindowKey,
    };
  }, [activeSeason?.id, currentSeasonalWindowKey]);

  const applySeasonData = useCallback((rows: ParsedRow[], records: FlightRecord[], mods: Map<string, FlightModification>) => {
    setFlightRecords(records);
    setDisplayRows(enrichRows(rows));
    setModifications(mods);
    setSelectedRecordIds((previous) => {
      const { unknownIds } = reconcileSeasonalSelection(
        Array.from(previous),
        buildSeasonalAvailableRecordIds(records, mods),
      );
      return unknownIds.length === 0 ? previous : new Set();
    });
    setExportAllSelected(false);
  }, []);

  const publishSeasonalWorkspaceChange = useCallback((
    seasonId: string,
    localRevision: number | null | undefined,
    affectedIds: string[] = [],
    syncMeta: LocalSyncMeta | null = null
  ) => {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision: localRevision ?? null,
      source: 'seasonal',
      affectedIds,
      syncMeta,
    });
  }, []);

  const applyTargetedCommittedImportRefresh = useCallback(async (
    remoteImport: RemoteSeasonalImportResult,
    operation: SeasonalFileActionOperation,
  ): Promise<boolean> => {
    const windowKey = buildSeasonalWindowKey({
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      flight: debouncedFilters.flight || null,
      route: debouncedFilters.route || null,
    });
    const refreshed = await loadTargetedCommittedImportRefresh({
      committedImport: remoteImport,
      loadSeasons: getSeasons,
      loadSnapshot: getSeasonalExportSnapshot,
    });
    const refreshedRecords = refreshed.window.records;
    const refreshedModifications = refreshed.window.modifications;
    const patternRows = buildPatternRowsFromRecords(refreshedRecords, refreshedModifications);
    const affectedRecordIds = refreshedRecords.map((record) => record.id);
    const applyInvalidation = validateSeasonalFileAction(operation);
    if (applyInvalidation) {
      showSeasonalFileActionInvalidation('import', applyInvalidation);
      return false;
    }

    setCachedSeasons(refreshed.seasons);
    setCachedSeasonData(remoteImport.seasonId, {
      rows: patternRows,
      records: refreshedRecords,
      modifications: refreshedModifications,
      seasonDataVersion: refreshed.season.dataVersion,
    });
    useSeasonWorkspaceStore.getState().setSeasons(refreshed.seasons);
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: remoteImport.seasonId,
      season: refreshed.season,
      rows: patternRows,
      records: refreshedRecords,
      modifications: refreshedModifications,
      syncMeta: refreshed.window.syncMeta,
      windowKey,
    });
    publishSeasonalWorkspaceChange(
      remoteImport.seasonId,
      remoteImport.serverHighWater,
      affectedRecordIds,
      refreshed.window.syncMeta,
    );

    const finalApplyInvalidation = validateSeasonalFileAction(operation);
    if (finalApplyInvalidation) {
      showSeasonalFileActionInvalidation('import', finalApplyInvalidation);
      return false;
    }
    loadedWindowKeyRef.current = windowKey;
    setSeasons(refreshed.seasons);
    setActiveSeason(refreshed.season);
    sessionStorage.setItem('activeSeasonId', remoteImport.seasonId);
    applySeasonData(patternRows, refreshedRecords, refreshedModifications);
    setSelectedRecordIds(new Set());
    setModHistory([]);
    setDraftState(null);
    setSyncSummary({
      pendingCount: refreshed.window.syncMeta.pendingCount,
      lastLocalChangeAt: refreshed.window.syncMeta.lastLocalChangeAt,
    });
    setLoadError(null);
    setLoading(false);
    setPage(0);
    setPendingCommittedImport(null);
    setPendingImportAttempt(null);
    setUploadProgress(buildImportProgress(
      'Import complete',
      100,
      `${remoteImport.sourceRowCount} source rows, ${remoteImport.flightRecordCount} flight records`,
    ));
    void appendAuditLogEntry({
      seasonId: remoteImport.seasonId,
      seasonCode: remoteImport.seasonCode,
      module: 'import',
      category: 'import',
      operation: `Imported season ${remoteImport.seasonCode}: ${remoteImport.flightRecordCount} flight records`,
      targetFlightIds: affectedRecordIds,
      targetFlightLabels: Array.from(new Set(
        refreshedRecords.map((record) => `${record.airline}${record.flightNumber}`),
      )).slice(0, 200),
      deltas: [{
        targetType: 'sync',
        targetId: remoteImport.seasonId,
        targetLabel: remoteImport.seasonCode,
        field: 'importSummary',
        before: null,
        after: {
          sourceRows: remoteImport.sourceRowCount,
          flightRecords: remoteImport.flightRecordCount,
          preservedOperationalRecords: remoteImport.preservedOperationalCount,
          removedImportedRecords: remoteImport.removedImportedCount,
          dataVersion: remoteImport.dataVersion,
          fileName: refreshed.season.fileName,
          batchId: remoteImport.batchId,
        },
      }],
      metadata: {
        sourceRows: remoteImport.sourceRowCount,
        flightRecords: remoteImport.flightRecordCount,
        preservedOperationalRecords: remoteImport.preservedOperationalCount,
        removedImportedRecords: remoteImport.removedImportedCount,
        dataVersion: remoteImport.dataVersion,
        serverHighWater: remoteImport.serverHighWater,
        checksum: remoteImport.checksum,
        batchId: remoteImport.batchId,
      },
    });
    void showAlert({
      title: 'Import Completed',
      message:
        `${remoteImport.sourceRowCount} source rows generated ${remoteImport.flightRecordCount} flight records. ` +
        `${remoteImport.preservedOperationalCount} operational records preserved; ` +
        `${remoteImport.removedImportedCount} prior imported records removed.`,
      tone: 'success',
    });
    return true;
  }, [
    applySeasonData,
    debouncedFilters.dateFrom,
    debouncedFilters.dateTo,
    debouncedFilters.flight,
    debouncedFilters.route,
    publishSeasonalWorkspaceChange,
    setActiveSeason,
    setDraftState,
    setPendingCommittedImport,
    setPendingImportAttempt,
    showAlert,
    showSeasonalFileActionInvalidation,
    validateSeasonalFileAction,
  ]);

  const loadSeasonRows = useCallback(async (
    season: Season,
    force = false,
    requestGuard?: { requestId: number; seasonId: string; windowKey: string }
  ) => {
    const windowKey = buildSeasonalWindowKey({
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      flight: debouncedFilters.flight || null,
      route: debouncedFilters.route || null,
    });
    const requestIsCurrent = () => !requestGuard || (
      fetchServerDataRequestRef.current === requestGuard.requestId &&
      latestRouteWindowRef.current.seasonId === requestGuard.seasonId &&
      latestRouteWindowRef.current.windowKey === requestGuard.windowKey
    );
    const cachedWindow = force
      ? null
      : readCachedWorkspaceWindow(useSeasonWorkspaceStore.getState().workspaces[season.id], windowKey);
    if (cachedWindow) {
      if (!requestIsCurrent()) return;
      loadedWindowKeyRef.current = windowKey;
      setActiveSeason(season);
      applySeasonData(cachedWindow.rows, cachedWindow.records, cachedWindow.modifications);
      setModHistory([]);
      setDraftState(null);
      setSyncSummary({
        pendingCount: cachedWindow.syncMeta?.pendingCount ?? 0,
        lastLocalChangeAt: cachedWindow.syncMeta?.lastLocalChangeAt ?? null,
      });
      return;
    }
    setLoadProgress(buildLoadProgress('Loading server workspace', 25, season.seasonCode));
    const serverWindow = await loadSeasonWorkspaceWindow({
      seasonId: season.id,
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      resourceType: 'schedule',
      limit: 100000,
    });
    if (serverWindow) {
      if (!requestIsCurrent()) return;
      loadedWindowKeyRef.current = windowKey;
      const records = serverWindow.records;
      const mods = serverWindow.modifications;
      const rows = buildPatternRowsFromRecords(records, mods);
      setLoadProgress(buildLoadProgress('Rendering seasonal schedule', 80, `${records.length} records`));
      setCachedSeasonData(season.id, {
        rows,
        records,
        modifications: mods,
        seasonDataVersion: season.dataVersion,
      });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: season.id,
        season,
        rows,
        records,
        modifications: mods,
        syncMeta: serverWindow.syncMeta,
        windowKey,
      });
      setActiveSeason(season);
      applySeasonData(rows, records, mods);
      setModHistory([]);
      setDraftState(null);
      setSyncSummary({
        pendingCount: serverWindow.syncMeta.pendingCount,
        lastLocalChangeAt: serverWindow.syncMeta.lastLocalChangeAt,
      });
      publishSeasonWorkspaceChanged({
        seasonId: season.id,
        localRevision: serverWindow.syncMeta.localRevision,
        source: 'server-window',
        syncMeta: serverWindow.syncMeta,
      });
      return;
    }
    throw new Error('Server seasonal schedule window is unavailable.');
  }, [applySeasonData, debouncedFilters.dateFrom, debouncedFilters.dateTo, debouncedFilters.flight, debouncedFilters.route, setActiveSeason, setDraftState]);

  const refreshSeasonalWindow = useCallback(() => {
    if (!activeSeason) return null;
    if (fileActionControllerRef.current.isFileActionActive()) return null;
    if (hasDraftChanges) return null;
    const snapshot = readWorkspaceWindowSnapshot(
      useSeasonWorkspaceStore.getState().workspaces[activeSeason.id],
      currentSeasonalWindowKey
    );
    if (!snapshot) return null;
    const rows = snapshot.rows.length > 0
      ? snapshot.rows
      : buildPatternRowsFromRecords(snapshot.records, snapshot.modifications);
    loadedWindowKeyRef.current = currentSeasonalWindowKey;
    setActiveSeason(activeSeason);
    applySeasonData(rows, snapshot.records, snapshot.modifications);
    setModHistory([]);
    setDraftState(null);
    setSyncSummary({
      pendingCount: snapshot.syncMeta?.pendingCount ?? 0,
      lastLocalChangeAt: snapshot.syncMeta?.lastLocalChangeAt ?? null,
    });
    setCachedSeasonData(activeSeason.id, {
      rows,
      records: snapshot.records,
      modifications: snapshot.modifications,
      seasonDataVersion: activeSeason.dataVersion,
    });
    return snapshot;
  }, [activeSeason, applySeasonData, currentSeasonalWindowKey, hasDraftChanges, setActiveSeason, setDraftState]);

  useSeasonWorkspaceRefresh({
    seasonId: activeSeason?.id,
    policy: 'on-activation',
    source: 'seasonal',
    onRefresh: () => {
      refreshSeasonalWindow();
    },
  });

  // Load seasons on mount
  useEffect(() => {
    (async () => {
      try {
        setLoadError(null);
        setLoadProgress(buildLoadProgress('Loading seasons...', 10, 'Checking available schedules'));
        const cachedList = getCachedSeasons();
        const list = cachedList ?? await getSeasons();
        if (!cachedList) setCachedSeasons(list);
        setSeasons(list);
        useSeasonWorkspaceStore.getState().setSeasons(list);
        if (list.length > 0) {
          // Restore last active season from sessionStorage
          const savedSeasonId = typeof window !== 'undefined' ? sessionStorage.getItem('activeSeasonId') : null;
          const restored = savedSeasonId ? list.find(s => s.id === savedSeasonId) : null;
          const target = restored ?? list[0];
          setActiveSeason(target);
          await loadSeasonRows(target);
        }
      } catch (err) {
        console.error('Load error:', err);
        setLoadError(getLoadErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSeasonRows, setActiveSeason]);

  const handleSeasonChange = useCallback(async (seasonId: string) => {
    if (fileActionControllerRef.current.isFileActionActive()) return;
    const found = seasons.find(s => s.id === seasonId);
    if (!found) return;
    setSelectedRecordIds(new Set());
    setActiveSeason(found);
    setPage(0);
    sessionStorage.setItem('activeSeasonId', seasonId);
    setLoading(true);
    setLoadError(null);
    setLoadProgress(buildLoadProgress('Loading seasons...', 10, found.seasonCode));
    try {
      await loadSeasonRows(found);
    } catch (err) {
      console.error('Load error:', err);
      setLoadError(getLoadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadSeasonRows, seasons, setActiveSeason]);

  const handleRetryLoad = useCallback(async () => {
    if (!activeSeason || fileActionControllerRef.current.isFileActionActive()) return;
    setLoading(true);
    setLoadError(null);
    try {
      await loadSeasonRows(activeSeason, true);
    } catch (err) {
      console.error('Load error:', err);
      setLoadError(getLoadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [activeSeason, loadSeasonRows]);

  const formatDate = (raw: string | number | undefined): string => {
    if (!raw) return '—';
    if (typeof raw === 'number') {
      const d = XLSX.SSF.parse_date_code(raw);
      return `${String(d.d).padStart(2, '0')}/${String(d.m).padStart(2, '0')}/${String(d.y).slice(-2)}`;
    }
    const parts = String(raw).split('-');
    if (parts.length >= 3) return `${parts[0]}/${parts[1]}/${parts[2]}`;
    return String(raw);
  };

  const activeDisplayLegs = useMemo(
    () => applyModificationsToLegs(flightRecordsToLegs(flightRecords), modifications, true),
    [flightRecords, modifications]
  );

  // Display-level grouping: aggregate one ARR or DEP flight identity per row.
  interface DisplayGroup {
    key: string;
    airline: string;
    side: 'A' | 'D';
    arrFlightNumber: string | null;
    depFlightNumber: string | null;
    routes: Set<string>;
    aircrafts: Set<string>;
    times: Set<string>;
    validityPeriods: Set<string>;
    daysOfWeek: boolean[];
    patternCount: number;
    recordIds: Set<string>;
    linkedPartners: Set<string>;
    linkTypes: Set<'overnight' | 'sameday'>;
    legs: FlightLeg[];
  }

  const displayGroups = useMemo((): DisplayGroup[] => {
    const legsByGroup = new Map<string, FlightLeg[]>();
    for (const leg of activeDisplayLegs) {
      const key = `${leg.airline}|${leg.type}|${leg.rawFlightNumber}`;
      const bucket = legsByGroup.get(key) ?? [];
      bucket.push(leg);
      legsByGroup.set(key, bucket);
    }

    return buildSeasonalDisplayGroups(flightRecords, modifications).map((snapshot) => {
      const legs = legsByGroup.get(snapshot.key) ?? [];
      const formattedPeriods = snapshot.validityPeriods.map((period) => {
        const [effective, discontinue] = period.split(' - ');
        return `${formatDate(effective)} - ${formatDate(discontinue)}`;
      });
      return {
        key: snapshot.key,
        airline: snapshot.airline,
        side: snapshot.side,
        arrFlightNumber: snapshot.arrFlightNumber,
        depFlightNumber: snapshot.depFlightNumber,
        routes: new Set(snapshot.routes),
        aircrafts: new Set(snapshot.aircrafts),
        times: new Set(snapshot.times),
        validityPeriods: new Set(formattedPeriods),
        daysOfWeek: snapshot.daysOfWeek,
        patternCount: snapshot.validityPeriods.length,
        recordIds: new Set(snapshot.recordIds),
        linkedPartners: new Set(snapshot.linkedPartners),
        linkTypes: new Set(snapshot.linkTypes),
        legs,
      };
    });
  }, [activeDisplayLegs, flightRecords, modifications]);

  const groupOverlapsDateFilter = useCallback((group: DisplayGroup, dateFrom: string, dateTo: string): boolean => {
    const fromMs = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
    const toMs = dateTo ? new Date(dateTo).getTime() : Infinity;
    return group.legs.some((leg) => {
      const legMs = new Date(leg.date).getTime();
      return legMs >= fromMs && legMs <= toMs;
    });
  }, []);

  const countGroupLegs = useCallback((group: DisplayGroup, dateFrom: string, dateTo: string) => {
    const fromMs = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
    const toMs = dateTo ? new Date(dateTo).getTime() : Infinity;
    let total = 0;
    let arr = 0;
    let dep = 0;
    const routes = new Set<string>();
    for (const leg of group.legs) {
      const legMs = new Date(leg.date).getTime();
      if (legMs < fromMs || legMs > toMs) continue;
      total += 1;
      if (leg.type === 'A') arr += 1;
      if (leg.type === 'D') dep += 1;
      if (leg.route) routes.add(leg.route);
    }
    return { total, arr, dep, routes };
  }, []);

  const linkModalGroup = useMemo(
    () => linkModalGroupKey ? displayGroups.find((group) => group.key === linkModalGroupKey) ?? null : null,
    [displayGroups, linkModalGroupKey]
  );

  const seasonalLinkCandidates = useMemo(() => {
    if (!linkModalGroup) return [];
    return buildSeasonalLinkCandidates(flightRecords, {
      airline: linkModalGroup.airline,
      side: linkModalGroup.side,
      arrFlightNumber: linkModalGroup.arrFlightNumber,
      depFlightNumber: linkModalGroup.depFlightNumber,
      recordIds: linkModalGroup.recordIds,
    });
  }, [flightRecords, linkModalGroup]);

  const toggleGroupSelection = useCallback((group: DisplayGroup) => {
    setExportAllSelected(false);
    setSelectedRecordIds((prev) => {
      const next = exportAllSelected ? new Set<string>() : new Set(prev);
      const ids = Array.from(group.recordIds);
      const allSelected = exportAllSelected || (ids.length > 0 && ids.every((id) => next.has(id)));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [exportAllSelected]);

  // Filtering on DisplayGroups
  const filteredGroups = useMemo(() => {
    let result = displayGroups;

    const { flight, type, route, aircraft, time, dateFrom, dateTo } = debouncedFilters;

    if (flight) {
      result = result.filter(g => matchesSeasonalFlightFilter({
        arrFlightNumber: g.arrFlightNumber,
        depFlightNumber: g.depFlightNumber,
        airline: g.airline,
      }, flight));
    }
    if (type) {
      const q = type.toLowerCase();
      result = result.filter(g => {
        const hasArr = !!g.arrFlightNumber;
        const hasDep = !!g.depFlightNumber;
        const typeStr = hasArr && hasDep ? 'turnaround arr dep' : (hasArr ? 'arr arrival' : 'dep departure');
        return typeStr.includes(q);
      });
    }
    if (route) {
      const q = route.toLowerCase();
      result = result.filter(g => Array.from(g.routes).some(r => r.toLowerCase().includes(q)));
    }
    if (aircraft) {
      const q = aircraft.toLowerCase();
      result = result.filter(g => Array.from(g.aircrafts).some(a => a.toLowerCase().includes(q)));
    }
    if (time) {
      const q = time.toLowerCase();
      result = result.filter(g => Array.from(g.times).some(t => t.toLowerCase().includes(q)));
    }
  if (dateFrom || dateTo) {
      result = result.filter(g => groupOverlapsDateFilter(g, dateFrom, dateTo));
    }

    return result;
  }, [displayGroups, debouncedFilters, groupOverlapsDateFilter]);

  const allSeasonSelected = exportAllSelected;
  const hasPartialSeasonSelection = !exportAllSelected && selectedRecordIds.size > 0;
  const toggleAllSeasonSelection = useCallback(() => {
    setExportAllSelected((current) => !current);
    setSelectedRecordIds(new Set());
  }, []);

  const totalPages = Math.ceil(filteredGroups.length / PAGE_SIZE);
  const pagedGroups = filteredGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Stats
  const flightStats = useMemo(() => {
    let total = 0;
    let arr = 0;
    let dep = 0;
    const routeSet = new Set<string>();
    
    filteredGroups.forEach(g => {
      const counted = countGroupLegs(g, debouncedFilters.dateFrom, debouncedFilters.dateTo);
      total += counted.total;
      arr += counted.arr;
      dep += counted.dep;
      counted.routes.forEach((route) => routeSet.add(route));
    });
    
    return { total, arr, dep, uniqueRoutes: routeSet.size };
  }, [countGroupLegs, filteredGroups, debouncedFilters.dateFrom, debouncedFilters.dateTo]);

  const handleExportUpdated = useCallback(async () => {
    if (!activeSeason) return;
    const exportSeason = activeSeason;
    const exportSelection: SeasonalExportSelection = {
      seasonId: exportSeason.id,
      dataVersion: exportSeason.dataVersion ?? 0,
      mode: exportAllSelected ? 'all' : 'ids',
      recordIds: Array.from(selectedRecordIds),
    };
    const initialBlock = getSeasonalFileActionBlock({
      action: 'export',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
      selectedCount: exportSelection.mode === 'all' ? 1 : exportSelection.recordIds.length,
      staleSelectionCount: 0,
    });
    if (initialBlock) {
      void showAlert({
        title: initialBlock.code === 'no-selection' ? 'Select flights to export' : 'Cannot Export',
        message: initialBlock.code === 'no-selection'
          ? 'Tick the flight rows you want to export. To export the full schedule, select all rows first.'
          : initialBlock.message,
        tone: initialBlock.code === 'no-selection' ? 'info' : 'warning',
      });
      return;
    }
    const operation = beginSeasonalFileAction('export');
    if (!operation) {
      void showAlert({
        title: 'Cannot Export',
        message: 'Another Seasonal operation is still running.',
        tone: 'warning',
      });
      return;
    }
    try {
      setIsExporting(true);
      const exportSnapshot = await getSeasonalExportSnapshot({
        seasonId: exportSeason.id,
        expectedDataVersion: exportSelection.dataVersion,
      });
      const snapshotInvalidation = validateSeasonalFileAction(operation);
      if (snapshotInvalidation) {
        showSeasonalFileActionInvalidation('export', snapshotInvalidation);
        return;
      }
      const effectiveSnapshotLegs = materializeEffectiveSeasonalLegs(
        exportSnapshot.records,
        exportSnapshot.modifications,
      );
      const selectedSnapshot = validateSeasonalExportSelection({
        selection: exportSelection,
        snapshotSeasonId: exportSnapshot.seasonId,
        snapshotDataVersion: exportSnapshot.dataVersion,
        effectiveLegs: effectiveSnapshotLegs,
      });
      if (!selectedSnapshot.valid) {
        const issue = selectedSnapshot.issues[0];
        const issueLeg = issue?.recordId
          ? effectiveSnapshotLegs.find((leg) => leg.id === issue.recordId)
          : null;
        const flightLabel = issueLeg ? `${issueLeg.flightNumber} on ${issueLeg.date}: ` : '';
        void showAlert({
          title: 'Cannot Export',
          message: `${issue?.code ?? 'selection'}: ${flightLabel}${issue?.message ?? 'Invalid export selection.'}`,
          tone: 'error',
        });
        return;
      }
      const snapshotBlock = getSeasonalFileActionBlock({
        action: 'export',
        hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
        busy: false,
        selectedCount: selectedSnapshot.legs.length,
        staleSelectionCount: selectedSnapshot.issues.filter((issue) => issue.code === 'unknown-record-id').length,
      });
      if (snapshotBlock) {
        void showAlert({ title: 'Cannot Export', message: snapshotBlock.message, tone: 'warning' });
        return;
      }
      const exportLegs = selectedSnapshot.legs;
      const canonicalExport = buildCanonicalSeasonalRows({
        records: exportSnapshot.records,
        modifications: exportSnapshot.modifications,
        selectedRecordIds: selectedSnapshot.recordIds,
      });
      const violations = findDuplicateFlightNumberViolations(exportLegs);
      if (violations.length > 0) {
        void showAlert({
          title: 'Cannot Export',
          message: `Duplicate flight number ${violations[0].flightNumber} on ${violations[0].date}.`,
          tone: 'error',
        });
        return;
      }
      const exportValidation = validateFlightLegsForSeasonalExport(exportLegs);
      if (!exportValidation.valid) {
        const issue = exportValidation.issues[0];
        const issueLeg = exportLegs.find((leg) => leg.id === issue.legId);
        void showAlert({
          title: 'Cannot Export',
          message: `${issue.code}: ${issueLeg ? `${issueLeg.flightNumber} on ${issueLeg.date}: ` : ''}${issue.message}`,
          tone: 'error',
        });
        return;
      }
      if (!canonicalExport.validation.valid) {
        void showAlert({
          title: 'Cannot Export',
          message: `round-trip: ${canonicalExport.validation.issues[0]?.message ?? 'Canonical seasonal export does not round-trip.'}`,
          tone: 'error',
        });
        return;
      }
      if (canonicalExport.rows.length === 0) {
        void showAlert({ title: 'Cannot Export', message: 'zero-selection: Export would create a blank workbook.', tone: 'error' });
        return;
      }
      const downloadInvalidation = validateSeasonalFileAction(operation);
      if (downloadInvalidation) {
        showSeasonalFileActionInvalidation('export', downloadInvalidation);
        return;
      }
      const result = await downloadCanonicalSeasonalExcel(canonicalExport.rows, exportSeason.seasonCode);
      notifyExportCompleted(result);
    } catch (err) {
      void showAlert({ title: 'Cannot Export', message: describeSeasonalExportFailure(err), tone: 'error' });
    } finally {
      setIsExporting(false);
      finishSeasonalFileAction(operation);
    }
  }, [
    activeSeason,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    exportAllSelected,
    isSeasonalFileActionBusyNow,
    notifyExportCompleted,
    selectedRecordIds,
    showAlert,
    showSeasonalFileActionInvalidation,
    validateSeasonalFileAction,
  ]);

  const handleUndo = useCallback(async (targetEntry: ModHistoryEntry) => {
    if (!activeSeason || syncInProgress) return;
    const mutation = beginSeasonalMutation();
    if (!mutation) return;
    setIsUndoing(true);
    try {
      const targetIdx = modHistory.findIndex((entry) => entry.id === targetEntry.id);
      if (targetIdx === -1) return;
      const historyToUndoFrom = modHistory;
      const entriesToUndo = historyToUndoFrom.slice(0, targetIdx + 1);
      const nextMods = revertModificationHistoryMap(modifications, entriesToUndo);
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
      const nativeSyncMeta = await runNativeScheduleMutation(
        activeSeason.id,
        Array.from(undoRecords.values()),
        Array.from(undoDeletedIds),
        Array.from(undoMods.values()),
        {
          id: `LOCAL_UNDO_${undoTimestamp}`,
          timestamp: undoTimestamp,
          description: `Undid ${targetEntry.description}`,
        },
        [],
        'seasonal'
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(nextRecords, nextMods);
      applySeasonData(nextRows, nextRecords, nextMods);
      setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession(historyToUndoFrom.slice(targetIdx + 1))));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
      setCachedSeasonData(activeSeason.id, {
        rows: nextRows,
        records: nextRecords,
        modifications: nextMods,
        seasonDataVersion: activeSeason.dataVersion,
      });
      const affectedIds = entriesToUndo.flatMap((entry) => [
        ...entry.changes.map((change) => change.legId),
        ...(entry.recordChanges?.map((change) => change.recordId) ?? []),
      ]);
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds,
        records: nextRecords,
        modifications: nextMods,
        syncMeta: nativeSyncMeta,
      });
      publishSeasonalWorkspaceChange(activeSeason.id, nativeSyncMeta.localRevision, affectedIds, nativeSyncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season: activeSeason,
        module: 'seasonal',
        operation: `Undid ${targetEntry.description}`,
        beforeRecords: flightRecords,
        afterRecords: nextRecords,
        beforeModifications: modifications,
        afterModifications: nextMods,
        targetRecordIds: affectedIds,
      }));
      setIsUndoOpen(false);
    } catch (err) {
      void showAlert({ title: 'Undo Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setIsUndoing(false);
      finishSeasonalMutation(mutation);
    }
  }, [activeSeason, applySeasonData, beginSeasonalMutation, finishSeasonalMutation, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, syncInProgress]);

  const handleDiscardSeasonalDraft = useCallback(() => {
    if (!activeSeason || !draftState) return;
    const mutation = beginSeasonalMutation();
    if (!mutation) return;
    try {
      setCachedSeasonData(activeSeason.id, {
        rows: draftState.baseRows,
        records: draftState.baseRecords,
        modifications: draftState.baseModifications,
        seasonDataVersion: activeSeason.dataVersion,
      });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        rows: draftState.baseRows,
        records: draftState.baseRecords,
        modifications: draftState.baseModifications,
      });
      applySeasonData(draftState.baseRows, draftState.baseRecords, draftState.baseModifications);
      setDraftState(null);
    } finally {
      finishSeasonalMutation(mutation);
    }
  }, [activeSeason, applySeasonData, beginSeasonalMutation, draftState, finishSeasonalMutation, setDraftState]);

  const commitDraftBeforeSave = useCallback(async () => {
    if (!activeSeason || !draftState || syncInProgress) return;
    const baseRecordIds = new Set(draftState.baseRecords.map((record) => record.id));
    const touchedIds = Array.from(new Set(draftState.modifications.map((mod) => mod.legId)));
    const addedRecords = flightRecords.filter((record) => !baseRecordIds.has(record.id));
    const regularMods = touchedIds
      .filter((id) => baseRecordIds.has(id))
      .map((id) => modifications.get(id))
      .filter((mod): mod is FlightModification => Boolean(mod));
    const targetRecordIds = [...addedRecords.map((record) => record.id), ...regularMods.map((mod) => mod.legId)];

    if (targetRecordIds.length === 0) {
      handleDiscardSeasonalDraft();
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
      season: activeSeason,
      module: 'seasonal',
      operation: description,
      beforeRecords: draftState.baseRecords,
      afterRecords: flightRecords,
      beforeModifications: draftState.baseModifications,
      afterModifications: modifications,
      targetRecordIds,
    });

    const mutation = beginSeasonalMutation();
    if (!mutation) throw new Error('Another Seasonal operation is still running.');
    try {
      const nativeSyncMeta = await runNativeScheduleMutation(
        activeSeason.id,
        addedRecords,
        [],
        regularMods,
        historyEntry,
        [],
        'seasonal'
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
      setDraftState(null);
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds: targetRecordIds,
        records: addedRecords,
        modifications: regularMods,
        syncMeta: nativeSyncMeta,
      });
      publishSeasonalWorkspaceChange(activeSeason.id, nativeSyncMeta.localRevision, targetRecordIds, nativeSyncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season: activeSeason,
        module: 'seasonal',
        operation: description,
        beforeRecords: draftState.baseRecords,
        afterRecords: flightRecords,
        beforeModifications: draftState.baseModifications,
        afterModifications: modifications,
        targetRecordIds,
      }));
    } catch (err) {
      throw err;
    } finally {
      finishSeasonalMutation(mutation);
    }
  }, [
    activeSeason,
    beginSeasonalMutation,
    draftState,
    finishSeasonalMutation,
    flightRecords,
    handleDiscardSeasonalDraft,
    modHistory,
    modifications,
    publishSeasonalWorkspaceChange,
    setDraftState,
    syncInProgress,
  ]);

  useSeasonSyncGuard(activeSeason?.id, 'seasonal', {
    blocked: seasonalFileActionActive,
    reason: uploading ? 'Importing seasonal file' : 'Exporting seasonal file',
    beforeSync: commitDraftBeforeSave,
  });
  useSeasonSyncGuard(activeSeason?.id, 'seasonal-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
    quiet: true,
    blockingUi: false,
  });
  useSeasonSyncGuard(activeSeason?.id, 'seasonal-draft', {
    blocked: false,
    quiet: true,
    blockingUi: false,
  });

  const handleDeleteGroup = useCallback(async (group: DisplayGroup) => {
    if (!activeSeason || syncInProgress) return;
    const mutation = beginSeasonalMutation();
    if (!mutation) return;
    try {
      const ids = Array.from(group.recordIds);
      if (ids.length === 0) return;

      const flightLabel = `${group.airline}${group.arrFlightNumber || group.depFlightNumber}`;
      const deletionTargets = resolveLinkedDeletionTargets(activeDisplayLegs, ids);
      let targetIds = deletionTargets.selectedIds;
      if (deletionTargets.hasActiveCounterpart) {
        const choice = await showChoice({
          title: 'Delete Linked Flight Pair',
          message: `${flightLabel} is linked to ${deletionTargets.counterpartIds.length} active counterpart occurrence(s).\n\nChoose whether to delete the full turnaround pair or only the selected leg.`,
          tone: 'warning',
          choices: [
            { value: 'pair', label: `Delete Entire Flight Pair (${deletionTargets.pairIds.length})`, tone: 'warning' },
            { value: 'selected', label: `Delete Selected Leg Only (${deletionTargets.selectedIds.length})` },
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (choice === 'pair') targetIds = deletionTargets.pairIds;
        else if (choice === 'selected') targetIds = deletionTargets.selectedIds;
        else return;
      } else {
        const shouldDelete = await showConfirm({
          title: 'Delete Flight Group',
          message: `Delete ${ids.length} flight occurrence(s) for ${flightLabel}?`,
          tone: 'warning',
          confirmLabel: 'Delete',
        });
        if (!shouldDelete) return;
      }

      const deleteMods = targetIds.map((id) => ({ legId: id, action: 'deleted' as const }));
      const nextMods = new Map(modifications);
      deleteMods.forEach((mod) => nextMods.set(mod.legId, mod));
      const baseDraft = draftState ?? {
        baseRows: displayRows as unknown as ParsedRow[],
        baseRecords: flightRecords,
        baseModifications: modifications,
        records: [],
        modifications: [],
      };
      const nextRows = buildPatternRowsFromRecords(flightRecords, nextMods);
      setModifications(nextMods);
      setDisplayRows(enrichRows(nextRows));
      setCachedSeasonData(activeSeason.id, {
        rows: nextRows,
        records: flightRecords,
        modifications: nextMods,
        seasonDataVersion: activeSeason.dataVersion,
      });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds: getAffectedIdsFromSeasonalModifications(deleteMods),
        rows: nextRows,
        records: flightRecords,
        modifications: nextMods,
      });
      setDraftState({
        ...baseDraft,
        modifications: [...baseDraft.modifications, ...deleteMods],
      });
      setSelectedRecordIds((prev) => {
        const next = new Set(prev);
        targetIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (err) {
      void showAlert({ title: 'Delete Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      finishSeasonalMutation(mutation);
    }
  }, [activeDisplayLegs, activeSeason, beginSeasonalMutation, displayRows, draftState, finishSeasonalMutation, flightRecords, modifications, setDraftState, showAlert, showChoice, showConfirm, syncInProgress]);

  const handleUnlinkGroup = useCallback(async (group: DisplayGroup) => {
    if (!activeSeason || syncInProgress) return;
    const mutation = beginSeasonalMutation();
    if (!mutation) return;
    try {
      const persistedIds = new Set(flightRecords.map((record) => record.id));
      const linkedIds = group.legs
        .filter((leg) => persistedIds.has(leg.id) && (leg.linkedRecordId || leg.linkType))
        .map((leg) => leg.id);
      if (linkedIds.length === 0) return;

      const result = unlinkFlightRecords(flightRecords, linkedIds);
      if (result.updatedRecords.length === 0) return;

      const flightLabel = `${group.airline}${group.arrFlightNumber || group.depFlightNumber}`;
      const counterpartCount = Math.max(0, result.updatedRecords.length - linkedIds.length);
      const counterpartText = counterpartCount > 0 ? ` and ${counterpartCount} counterpart record(s)` : '';
      const shouldUnlink = await showConfirm({
        title: 'Unlink Flight Group',
        message: `Unlink ${linkedIds.length} linked occurrence(s) for ${flightLabel}${counterpartText}?\nThis applies to the full Seasonal row. Use Detailed Schedule for a narrower period.`,
        tone: 'warning',
        confirmLabel: 'Unlink',
      });
      if (!shouldUnlink) return;

      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Unlinked ${result.updatedRecords.length} flight occurrence(s) for ${flightLabel}`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      const nativeSyncMeta = await runNativeScheduleMutation(
        activeSeason.id,
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
        'seasonal'
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(result.records, modifications);
      setFlightRecords(result.records);
      setDisplayRows(enrichRows(nextRows));
      if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
      setCachedSeasonData(activeSeason.id, {
        rows: nextRows,
        records: result.records,
        modifications,
        seasonDataVersion: activeSeason.dataVersion,
      });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds: result.updatedIds,
        rows: nextRows,
        records: result.updatedRecords,
        modifications,
        syncMeta: nativeSyncMeta,
      });
      publishSeasonalWorkspaceChange(activeSeason.id, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season: activeSeason,
        module: 'seasonal',
        operation: historyEntry?.description ?? `Unlinked ${result.updatedRecords.length} flight occurrence(s) for ${flightLabel}`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
      setSelectedRecordIds((prev) => {
        const next = new Set(prev);
        result.updatedIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (err) {
      void showAlert({ title: 'Unlink Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      finishSeasonalMutation(mutation);
    }
  }, [activeSeason, beginSeasonalMutation, finishSeasonalMutation, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, showConfirm, syncInProgress]);

  const handleApplySeasonalLinkCandidate = useCallback(async (candidate: SeasonalLinkCandidate) => {
    if (!activeSeason || syncInProgress) return;
    const mutation = beginSeasonalMutation();
    if (!mutation) return;

    try {
      setLinkingCandidateKey(candidate.key);
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
        activeSeason.id,
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
        'seasonal'
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(result.records, modifications);
      setFlightRecords(result.records);
      setDisplayRows(enrichRows(nextRows));
      if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
      setCachedSeasonData(activeSeason.id, {
        rows: nextRows,
        records: result.records,
        modifications,
        seasonDataVersion: activeSeason.dataVersion,
      });
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds: result.updatedIds,
        rows: nextRows,
        records: result.updatedRecords,
        modifications,
        syncMeta: nativeSyncMeta,
      });
      publishSeasonalWorkspaceChange(activeSeason.id, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season: activeSeason,
        module: 'seasonal',
        operation: historyEntry?.description ?? `Linked ${result.updatedRecords.length} ${candidate.linkType} flight occurrence(s)`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
        targetRecordIds: result.updatedIds,
      }));
      setLinkModalGroupKey(null);
    } catch (err) {
      void showAlert({ title: 'Link Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setLinkingCandidateKey(null);
      finishSeasonalMutation(mutation);
    }
  }, [activeSeason, beginSeasonalMutation, finishSeasonalMutation, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, syncInProgress]);

  const handleSync = useCallback(async () => {
    if (!activeSeason || syncInProgress || fileActionControllerRef.current.isFileActionActive()) return;
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
  }, [activeSeason, showAlert, syncInProgress, syncNow]);

  const fetchServerData = useCallback(async () => {
    if (!activeSeason || fetchingServerData || syncInProgress || fileActionControllerRef.current.isFileActionActive()) return;
    if (hasDraftChanges) return;
    const windowKey = buildSeasonalWindowKey({
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      flight: debouncedFilters.flight || null,
      route: debouncedFilters.route || null,
    });
    const requestId = ++fetchServerDataRequestRef.current;
    setFetchingServerData(true);
    try {
      await loadSeasonRows(activeSeason, true, {
        requestId,
        seasonId: activeSeason.id,
        windowKey,
      });
    } catch (err) {
      void showAlert({ title: 'Fetch data failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [activeSeason, debouncedFilters.dateFrom, debouncedFilters.dateTo, debouncedFilters.flight, debouncedFilters.route, fetchingServerData, hasDraftChanges, loadSeasonRows, showAlert, syncInProgress]);

  // Import handler
  const handleImportClick = useCallback(() => {
    if (pendingImportAttemptRef.current || pendingCommittedImportRef.current) {
      void showAlert({
        title: 'Import Recovery Pending',
        message: 'Finish the pending Resume/Check or committed import Refresh before importing another file.',
        tone: 'warning',
      });
      return;
    }
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Import Blocked', message: block.message, tone: 'warning' });
      return;
    }
    fileInputRef.current?.click();
  }, [isSeasonalFileActionBusyNow, showAlert]);

  const handlePendingCommittedRefresh = useCallback(async () => {
    const committedImport = pendingCommittedImportRef.current;
    if (!committedImport) return;
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Refresh Blocked', message: block.message, tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) return;
    setUploading(true);
    setUploadProgress(buildImportProgress('Refreshing committed import', 90, committedImport.seasonCode));
    try {
      await applyTargetedCommittedImportRefresh(committedImport, operation);
    } catch (error) {
      const failure = buildSeasonalImportCommittedRefreshFailure(committedImport, error);
      void showAlert({ title: failure.title, message: failure.message, tone: 'warning' });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    applyTargetedCommittedImportRefresh,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    showAlert,
  ]);

  const handleResumeImportAttempt = useCallback(async () => {
    const attempt = pendingImportAttemptRef.current;
    if (!attempt) return;
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Resume Blocked', message: block.message, tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) return;
    setUploading(true);
    setUploadProgress(buildImportProgress('Checking import status', 55, attempt.requestId));
    try {
      const commitInvalidation = validateSeasonalFileAction(operation);
      if (commitInvalidation) {
        showSeasonalFileActionInvalidation('import', commitInvalidation);
        return;
      }
      const remoteImport = await resumeSeasonalImportAttemptOnce(attempt, applySeasonalImportRemote);
      setPendingImportAttempt(null);
      setPendingCommittedImport(remoteImport);
      setUploadProgress(buildImportProgress('Refreshing schedule', 90, remoteImport.seasonCode));
      try {
        await applyTargetedCommittedImportRefresh(remoteImport, operation);
      } catch (refreshError) {
        const failure = buildSeasonalImportCommittedRefreshFailure(remoteImport, refreshError);
        void showAlert({ title: failure.title, message: failure.message, tone: 'warning' });
      }
    } catch (error) {
      if (error instanceof SeasonalImportV2StatusUnknownError) {
        setPendingImportAttempt(attempt);
        const notice = buildSeasonalImportStatusUnknownNotice(attempt, error);
        void showAlert({ title: notice.title, message: notice.message, tone: 'warning' });
      } else {
        setPendingImportAttempt(null);
        void showAlert({ title: 'Import Failed', message: getLoadErrorMessage(error), tone: 'error' });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    applyTargetedCommittedImportRefresh,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    setPendingCommittedImport,
    setPendingImportAttempt,
    showAlert,
    showSeasonalFileActionInvalidation,
    validateSeasonalFileAction,
  ]);

  const handleFile = useCallback(async (file: File) => {
    if (pendingImportAttemptRef.current || pendingCommittedImportRef.current) {
      void showAlert({
        title: 'Import Recovery Pending',
        message: 'Finish the pending Resume/Check or committed import Refresh before importing another file.',
        tone: 'warning',
      });
      return;
    }
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Import Blocked', message: block.message, tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) {
      void showAlert({
        title: 'Import Blocked',
        message: 'Another Seasonal operation is still running.',
        tone: 'warning',
      });
      return;
    }
    setUploading(true);
    let attemptedImport: RemoteSeasonalImportInput | null = null;
    try {
      setUploadProgress(buildImportProgress('Parsing file', 5));
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const { seasonCode, rows: parsedRows, issues } = parseSeasonalSchedule(workbook);

      if (issues.length > 0) {
        const visibleIssues = issues.slice(0, 10).map((issue) => issue.message);
        const remainingCount = issues.length - visibleIssues.length;
        const remainingMessage = remainingCount > 0 ? `\n...and ${remainingCount} more issue(s).` : '';
        void showAlert({
          title: 'Import Failed',
          message: `${visibleIssues.join('\n')}${remainingMessage}`,
          tone: 'warning',
        });
        return;
      }

      if (parsedRows.length === 0) {
        void showAlert({ title: 'Import Failed', message: 'File contains no valid data.', tone: 'warning' });
        return;
      }

      setUploadProgress(buildImportProgress('Checking local changes', 24));
      const existing = await findSeasonByCode(seasonCode);
      if (existing) {
        const targetPendingCount = existing.id === activeSeason?.id ? syncPendingCount : 0;
        const dirtyGuard = getDirtyImportGuard({
          targetSeasonId: existing.id,
          targetSeasonCode: seasonCode,
          activeSeasonId: activeSeason?.id ?? null,
          pendingCount: targetPendingCount,
          conflictCount: 0,
        });

        if (dirtyGuard.shouldBlock) {
          void showAlert({
            title: 'Import Blocked',
            message: `${dirtyGuard.message}\n\nSave pending changes before importing this season.`,
            tone: 'warning',
          });
          return;
        }
      }

      setUploadProgress(buildImportProgress('Preparing source rows', 30, `${parsedRows.length} source rows`));
      attemptedImport = await prepareSeasonalImportV2Attempt({
        seasonId: existing?.id ?? null,
        seasonCode,
        expectedDataVersion: existing ? existing.dataVersion ?? null : 0,
        mode: 'standard',
        fileName: file.name,
        uploadedAt: Date.now(),
        sourceRows: parsedRows,
      });
      const commitInvalidation = validateSeasonalFileAction(operation);
      if (commitInvalidation) {
        showSeasonalFileActionInvalidation('import', commitInvalidation);
        return;
      }
      setPendingImportAttempt(attemptedImport);
      setUploadProgress(buildImportProgress('Committing seasonal import', 55, `${attemptedImport.sourceRows.length} source rows`));
      const remoteImport = await applySeasonalImportRemote(attemptedImport);
      setPendingImportAttempt(null);
      setPendingCommittedImport(remoteImport);
      try {
        setUploadProgress(buildImportProgress('Refreshing schedule', 90, remoteImport.seasonCode));
        await applyTargetedCommittedImportRefresh(remoteImport, operation);
      } catch (refreshError) {
        const failure = buildSeasonalImportCommittedRefreshFailure(remoteImport, refreshError);
        void showAlert({ title: failure.title, message: failure.message, tone: 'warning' });
        return;
      }
    } catch (err) {
      console.error('Upload error:', err);
      if (err instanceof SeasonalImportV2StatusUnknownError && attemptedImport) {
        setPendingImportAttempt(attemptedImport);
        const notice = buildSeasonalImportStatusUnknownNotice(attemptedImport, err);
        void showAlert({ title: notice.title, message: notice.message, tone: 'warning' });
      } else {
        if (attemptedImport && !pendingCommittedImportRef.current) setPendingImportAttempt(null);
        void showAlert({ title: 'Import Failed', message: getLoadErrorMessage(err), tone: 'error' });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    activeSeason,
    applyTargetedCommittedImportRefresh,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    setPendingCommittedImport,
    setPendingImportAttempt,
    showAlert,
    showSeasonalFileActionInvalidation,
    syncPendingCount,
    validateSeasonalFileAction,
  ]);

  const handleRowDoubleClick = useCallback((group: DisplayGroup) => {
    if (!activeSeason || fileActionControllerRef.current.isFileActionActive()) return;
    router.push(buildSeasonalLinkRoute(activeSeason.id, group, {
      dateFrom: debouncedFilters.dateFrom,
      dateTo: debouncedFilters.dateTo,
    }));
  }, [activeSeason, router, debouncedFilters.dateFrom, debouncedFilters.dateTo]);

  const Badge = ({ count }: { count: number }) => {
    if (count <= 1) return null;
    return <span className="ml-2 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-[10px] font-bold border border-secondary/20">+{count - 1}</span>;
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <WorkspacePageHeader
          title="Seasonal Schedule"
          subtitle={activeSeason ? buildSeasonDisplayLabel(activeSeason) : 'Manage and review master flight schedules for the upcoming season.'}
          seasonControl={seasons.length > 0 && (
            <div className="relative group">
              <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                <span className="material-symbols-outlined text-[18px] text-primary">calendar_today</span>
              </div>
              <select
                value={activeSeason?.id ?? ''}
                onChange={(event) => handleSeasonChange(event.target.value)}
                disabled={seasonalFileActionActive}
                className="min-w-[200px] cursor-pointer appearance-none rounded-lg border border-outline-variant bg-surface-container-low py-2 pl-10 pr-10 text-sm font-medium text-on-surface shadow-sm transition-colors hover:bg-surface-container-high focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {seasons.map((seasonItem) => (
                  <option key={seasonItem.id} value={seasonItem.id} className="text-base">{buildSeasonDisplayLabel(seasonItem)}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-on-surface-variant transition-colors group-hover:text-primary">
                <span className="material-symbols-outlined text-[18px]">expand_more</span>
              </div>
            </div>
          )}
          statusControls={activeSeason && (
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
                disabled={syncInProgress || seasonalFileActionActive}
                onFetch={fetchServerData}
              />
              <SyncActionButton
                syncing={syncInProgress || seasonalFileActionActive}
                pendingCount={syncPendingCount}
                draftCount={draftChangeCount}
                progress={syncProgress}
                onSync={handleSync}
              />
            </>
          )}
          draftControls={hasDraftChanges && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900">
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              <span className="text-xs font-semibold">
                {draftChangeCount} draft changes
              </span>
              <button
                onClick={handleDiscardSeasonalDraft}
                disabled={syncInProgress || seasonalFileActionActive}
                className="rounded px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          )}
          primaryActions={activeSeason && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 font-label-caps text-label-caps text-on-primary shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  if (!fileActionControllerRef.current.isFileActionActive()) setIsNewFlightOpen(true);
                }}
                disabled={syncInProgress || hasDraftChanges || seasonalFileActionActive}
                title="Create a new seasonal flight"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                New Flight
              </button>
              <div className="relative">
                <button
                  className="flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-1.5 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={syncInProgress || hasDraftChanges || modHistory.length === 0 || isUndoing || seasonalFileActionActive}
                  onClick={() => setIsUndoOpen(!isUndoOpen)}
                  title="Undo local changes"
                >
                  <span className={`material-symbols-outlined text-[16px] ${isUndoing ? 'animate-spin' : ''}`}>{isUndoing ? 'sync' : 'undo'}</span>
                  Undo{modHistory.length > 0 ? ` (${modHistory.length})` : ''}
                </button>
                {isUndoOpen && modHistory.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setIsUndoOpen(false)} />
                    <div className="absolute left-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg sm:left-auto sm:right-0">
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
                              disabled={isUndoing || seasonalFileActionActive}
                              className="flex-shrink-0 rounded-lg bg-error-container px-3 py-1.5 text-xs font-medium text-on-error-container transition-colors hover:bg-error/20 disabled:opacity-50"
                            >
                              {idx === 0 ? 'Undo' : 'Revert'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".xls,.xlsx"
          style={{ display: 'none' }}
          onChange={(event) => { if (event.target.files?.[0]) handleFile(event.target.files[0]); }}
        />

        {/* Main Canvas */}
        <main className="min-h-0 flex-1 overflow-y-auto p-lg bg-surface">
          {pendingImportAttempt && !uploading && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Import status unknown</div>
                <div className="mt-1 break-all text-xs text-amber-900">
                  Request {pendingImportAttempt.requestId} requires an explicit server check.
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void handleResumeImportAttempt(); }}
                disabled={seasonalFileActionBusy || hasDraftChanges}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-amber-900 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                Resume/Check
              </button>
            </div>
          )}
          {pendingCommittedImport && !uploading && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-sky-300 bg-sky-50 p-4 text-sky-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Import committed, refresh pending</div>
                <div className="mt-1 text-xs text-sky-900">
                  {pendingCommittedImport.seasonCode} was committed as batch {pendingCommittedImport.batchId}.
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void handlePendingCommittedRefresh(); }}
                disabled={seasonalFileActionBusy || hasDraftChanges}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-sky-800 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                Refresh
              </button>
            </div>
          )}
          {uploading && (
            <div className="mb-4 p-4 bg-primary-fixed rounded-lg border border-primary/20">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined animate-spin text-primary">sync</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-primary truncate">{uploadProgress?.label ?? 'Importing'}</span>
                    <span className="text-sm font-semibold tabular-nums text-primary">{uploadProgress?.percent ?? 0}%</span>
                  </div>
                  {uploadProgress?.detail && (
                    <div className="mt-0.5 text-xs text-primary/80">{uploadProgress.detail}</div>
                  )}
                </div>
              </div>
              <div
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-primary/15"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress?.percent ?? 0}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${uploadProgress?.percent ?? 0}%` }}
                />
              </div>
            </div>
          )}
          {syncProgress && (
            <div className="mb-4 p-3 bg-surface-container-low rounded-lg border border-outline-variant text-sm text-on-surface-variant">
              {syncProgress}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter mb-md" aria-label="Seasonal schedule KPI summary">
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Total Flight</span>
              <div className="flex items-baseline gap-2">
                <span className="font-h2 text-h2 text-on-surface">{flightStats.total.toLocaleString()}</span>
                <span className="text-sm text-on-surface-variant">
                  (ARR: {flightStats.arr.toLocaleString()} / DEP: {flightStats.dep.toLocaleString()})
                </span>
              </div>
            </div>
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Active Routes</span>
              <span className="font-h2 text-h2 text-on-surface">{flightStats.uniqueRoutes.toLocaleString()}</span>
            </div>
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Season Validity</span>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-outline text-[18px]">date_range</span>
                <span className="font-body-sm text-body-sm text-on-surface">
                  {activeSeason ? `${formatDate(activeSeason.effectiveStart)} - ${formatDate(activeSeason.effectiveEnd)}` : '-'}
                </span>
              </div>
            </div>
          </div>

          <div className="mb-lg flex flex-col gap-3 rounded-xl border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm md:flex-row md:items-center md:justify-between" aria-label="Seasonal schedule table toolbar">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="flex items-center gap-1.5 bg-primary text-on-primary text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleImportClick}
                disabled={seasonalFileActionBusy || hasDraftChanges || seasonalImportRecoveryPending}
              >
                <span className="material-symbols-outlined text-[16px]">cloud_upload</span>
                Import
              </button>
              <button
                className="flex items-center gap-1.5 border border-outline-variant text-on-surface text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-surface-container-low transition-colors"
                onClick={() => setFilters({flight: '', type: '', route: '', aircraft: '', time: '', dateFrom: '', dateTo: ''})}
              >
                <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
                Clear Filters
              </button>
              <button
                className="flex items-center gap-1.5 bg-tertiary-container text-on-tertiary-container text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-tertiary-container/80 transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleExportUpdated}
                disabled={(!exportAllSelected && (activeDisplayLegs.length === 0 || selectedRecordIds.size === 0)) || seasonalFileActionBusy || hasDraftChanges}
                title={isExporting ? 'Exporting selected flights' : exportAllSelected ? 'Export all flights in season' : selectedRecordIds.size === 0 ? 'Select flights to export' : 'Export selected flights'}
              >
                <span className={`material-symbols-outlined text-[16px] ${isExporting ? 'animate-spin' : ''}`}>{isExporting ? 'sync' : 'download'}</span>
                {isExporting ? 'Exporting...' : exportAllSelected ? 'Export All' : selectedRecordIds.size > 0 ? `Export (${selectedRecordIds.size})` : 'Export'}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-on-surface-variant">
              <span>{filteredGroups.length.toLocaleString()} groups after filters</span>
              <span>{exportAllSelected ? 'All season flights selected' : `${selectedRecordIds.size.toLocaleString()} selected for export`}</span>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-surface-variant shadow-sm overflow-hidden flex flex-col">
            {loading ? (
              <LoadingStatusPanel progress={loadProgress} className="min-h-[320px]" />
            ) : loadError ? (
              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="font-title-sm text-title-sm text-error">Cannot load schedule data</div>
                <div className="max-w-xl font-body-sm text-body-sm text-on-surface-variant">{loadError}</div>
                {activeSeason && (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <FetchServerUpdatesButton
                      fetching={fetchingServerData}
                      progress={fetchProgress}
                      disabled={syncInProgress || seasonalFileActionActive}
                      onFetch={fetchServerData}
                    />
                    <button
                      type="button"
                      onClick={() => { void handleRetryLoad(); }}
                      disabled={seasonalFileActionActive}
                      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md text-on-primary shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[18px]">refresh</span>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ) : activeDisplayLegs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-on-surface-variant">
                <div>{hasActiveFilters ? 'No flights match the current filters.' : 'No data available. Please import a seasonal schedule file.'}</div>
                {hasActiveFilters ? (
                  <button
                    type="button"
                    className="flex items-center gap-2 border border-outline-variant text-on-surface font-label-caps text-label-caps px-4 py-2 rounded-lg hover:bg-surface-container-low transition-colors"
                    onClick={() => setFilters({flight: '', type: '', route: '', aircraft: '', time: '', dateFrom: '', dateTo: ''})}
                  >
                    <span className="material-symbols-outlined text-[18px]">filter_alt_off</span>
                    Clear Filters
                  </button>
                ) : activeSeason && (
                  <FetchServerUpdatesButton
                    fetching={fetchingServerData}
                    progress={fetchProgress}
                    disabled={syncInProgress || seasonalFileActionActive}
                    onFetch={fetchServerData}
                  />
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-low border-b border-surface-variant">
                        <th className="py-3 px-3 align-top w-[4%]">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={allSeasonSelected}
                              ref={(node) => {
                                if (node) node.indeterminate = hasPartialSeasonSelection;
                              }}
                              onChange={toggleAllSeasonSelection}
                              disabled={!activeSeason}
                              aria-label="Select all flights in season for export"
                              className="h-4 w-4 rounded border-outline text-primary focus:ring-primary disabled:opacity-40"
                            />
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Export</span>
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Flight No</span>
                            <input 
                              placeholder="Filter..." 
                              value={filters.flight}
                              onChange={e => setFilters({...filters, flight: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[10%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Type</span>
                            <input 
                              placeholder="ARR/DEP..." 
                              value={filters.type}
                              onChange={e => setFilters({...filters, type: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Route</span>
                            <input 
                              placeholder="Filter..." 
                              value={filters.route}
                              onChange={e => setFilters({...filters, route: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[10%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">A/C Type</span>
                            <input 
                              placeholder="Filter..." 
                              value={filters.aircraft}
                              onChange={e => setFilters({...filters, aircraft: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Time (STA/STD)</span>
                            <input 
                              placeholder="Filter..." 
                              value={filters.time}
                              onChange={e => setFilters({...filters, time: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Op. Days</span>
                            <div className="h-[26px]"></div> {/* spacer to align with inputs */}
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[20%]">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Validity Period</span>
                            <div className="flex items-center gap-1">
                              <input 
                                type="date"
                                value={filters.dateFrom}
                                onChange={e => setFilters({...filters, dateFrom: e.target.value})}
                                className="w-full bg-surface-container-highest border border-surface-variant rounded px-1 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                                title="Start Date"
                              />
                              <span className="text-outline-variant text-xs">-</span>
                              <input 
                                type="date"
                                value={filters.dateTo}
                                onChange={e => setFilters({...filters, dateTo: e.target.value})}
                                className="w-full bg-surface-container-highest border border-surface-variant rounded px-1 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                                title="End Date"
                              />
                            </div>
                          </div>
                        </th>
                        <th className="py-3 px-2 align-top w-[8%]" aria-label="Actions column">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Actions</span>
                            <div className="h-[26px]"></div>
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-variant font-data-tabular text-data-tabular text-on-surface">
                      {pagedGroups.map((group) => {
                        const hasArr = !!group.arrFlightNumber;
                        const hasDep = !!group.depFlightNumber;
                        const arrDisplay = hasArr ? `${group.airline}${group.arrFlightNumber}` : null;
                        const depDisplay = hasDep ? `${group.airline}${group.depFlightNumber}` : null;
                        const combinedFlight = hasArr && hasDep ? `${arrDisplay} / ${depDisplay}` : (arrDisplay ?? depDisplay);
                        const linkAction = getSeasonalLinkActionState({
                          recordCount: group.recordIds.size,
                          linkedPartnerCount: group.linkedPartners.size,
                        });
                        
                        const borderClass = hasArr && hasDep ? 'border-l-tertiary-container' : (hasArr ? 'border-l-primary-container border-dashed' : 'border-l-secondary-container border-dashed');
                        
                        return (
                          <tr key={group.key} className="hover:bg-primary-container/10 transition-colors cursor-pointer group" onDoubleClick={() => handleRowDoubleClick(group)}>
                            <td className="py-3 px-3 whitespace-nowrap" onDoubleClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={exportAllSelected || (group.recordIds.size > 0 && Array.from(group.recordIds).every((id) => selectedRecordIds.has(id)))}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  toggleGroupSelection(group);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Select ${combinedFlight ?? 'flight'} for export`}
                                className="h-4 w-4 rounded border-outline text-primary focus:ring-primary"
                              />
                            </td>
                            <td className={`py-3 px-4 whitespace-nowrap border-l-4 ${borderClass}`}>
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-primary">{combinedFlight}</span>
                                {group.linkedPartners.size > 0 && (
                                  <span className="inline-flex items-center gap-1 text-tertiary text-[11px]" title={Array.from(group.linkedPartners).join(', ')}>
                                    <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                                      {group.linkTypes.has('overnight') ? 'nights_stay' : 'sync_alt'}
                                    </span>
                                    <span>{Array.from(group.linkedPartners)[0]}</span>
                                    <Badge count={group.linkedPartners.size} />
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              <div className="flex gap-2">
                                {hasArr && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-primary-container text-on-primary-container">ARR</span>
                                )}
                                {hasDep && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-secondary-container text-on-secondary-container">DEP</span>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              {Array.from(group.routes)[0] || '—'}
                              <Badge count={group.routes.size} />
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap text-on-surface-variant">
                              {Array.from(group.aircrafts)[0] || '—'}
                              <Badge count={group.aircrafts.size} />
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              {Array.from(group.times)[0] || '—'}
                              <Badge count={group.times.size} />
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              <div className="flex gap-1 text-xs">
                                {group.daysOfWeek.map((on, i) => (
                                  <span key={i} className={`w-4 h-4 flex items-center justify-center rounded ${on ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-variant text-outline'}`}>
                                    {DAY_LABELS[i]}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap text-on-surface-variant">
                              <div className="flex items-center">
                                {Array.from(group.validityPeriods)[0]}
                                <Badge count={group.validityPeriods.size} />
                              </div>
                            </td>
                            <td className="py-3 px-2 whitespace-nowrap" onDoubleClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                {linkAction.canLink && (
                                  <button
                                    className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold text-primary hover:bg-primary-container/40 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                    title="Show matching flight legs to link"
                                    disabled={seasonalFileActionActive}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!fileActionControllerRef.current.isFileActionActive()) setLinkModalGroupKey(group.key);
                                    }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link</span>
                                    Link
                                  </button>
                                )}
                                {linkAction.canUnlink && (
                                  <button
                                    className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold text-tertiary hover:bg-tertiary-container/40 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                    title="Unlink this full Seasonal row"
                                    disabled={seasonalFileActionActive}
                                    onClick={(e) => { e.stopPropagation(); handleUnlinkGroup(group); }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link_off</span>
                                    Unlink
                                  </button>
                                )}
                                <button
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-outline hover:bg-error-container hover:text-error transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                  title="Delete flight group"
                                  disabled={seasonalFileActionActive}
                                  onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group); }}
                                >
                                  <span className="material-symbols-outlined text-[16px]">delete</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="bg-surface-container-low border-t border-surface-variant px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Showing {page * PAGE_SIZE + 1} to {Math.min((page + 1) * PAGE_SIZE, filteredGroups.length)} of {filteredGroups.length.toLocaleString()} groups</span>
                  <div className="flex items-center gap-2">
                    <span className="font-body-sm text-body-sm text-on-surface-variant">Page {page + 1} of {totalPages}</span>
                    <div className="flex gap-1">
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-outline disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page === 0}
                        onClick={() => setPage(0)}
                        title="First page"
                      >
                        <span className="material-symbols-outlined text-[20px]">first_page</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-outline disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page === 0}
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        title="Previous page"
                      >
                        <span className="material-symbols-outlined text-[20px]">chevron_left</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        title="Next page"
                      >
                        <span className="material-symbols-outlined text-[20px]">chevron_right</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage(totalPages - 1)}
                        title="Last page"
                      >
                        <span className="material-symbols-outlined text-[20px]">last_page</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
      {linkModalGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 px-4" onClick={() => setLinkModalGroupKey(null)}>
          <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-surface shadow-xl border border-outline-variant" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-surface-variant px-5 py-4 bg-surface-container-low">
              <div>
                <h2 className="font-h3 text-h3 text-on-surface">Matching flight legs</h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {linkModalGroup.airline}{linkModalGroup.arrFlightNumber ?? linkModalGroup.depFlightNumber}
                </p>
              </div>
              <button
                className="p-1 rounded hover:bg-surface-variant text-outline hover:text-on-surface transition-colors"
                onClick={() => setLinkModalGroupKey(null)}
                aria-label="Close link candidates"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              {seasonalLinkCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-4 py-8 text-center text-on-surface-variant">
                  No matching unlinked counterpart found.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {seasonalLinkCandidates.map((candidate) => (
                    <div
                      key={candidate.key}
                      className="flex items-center justify-between gap-4 rounded-lg border border-outline-variant bg-surface-container-low px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-primary">{candidate.flightNumber}</span>
                          <span className="rounded bg-surface-variant px-1.5 py-0.5 text-[11px] font-semibold uppercase text-on-surface-variant">
                            {candidate.linkType}
                          </span>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {candidate.matchCount} occurrence{candidate.matchCount === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-body-sm text-body-sm text-on-surface-variant">
                          <span>{candidate.route}</span>
                          <span>{candidate.schedule}</span>
                          <span>{candidate.aircraft}</span>
                          <span>{candidate.effective} - {candidate.discontinue}</span>
                        </div>
                      </div>
                      <button
                        className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        disabled={linkingCandidateKey !== null || seasonalFileActionActive}
                        onClick={() => handleApplySeasonalLinkCandidate(candidate)}
                      >
                        {linkingCandidateKey === candidate.key ? 'Linking' : `Link ${candidate.matchCount}`}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* New Flight Modal */}
      <NewFlightModal
        isOpen={isNewFlightOpen}
        onClose={() => setIsNewFlightOpen(false)}
        mode="seasonal"
        seasonStart={activeSeason?.effectiveStart}
        seasonEnd={activeSeason?.effectiveEnd}
        onSubmitSeasonal={async (row) => {
          if (!activeSeason || syncInProgress) return;
          const mutation = beginSeasonalMutation();
          if (!mutation) return;
          try {
            const nextRowIndex = Math.max(0, ...displayRows.map((displayRow) => displayRow.rowIndex)) + 1;
            const savedRow = { ...row, rowIndex: nextRowIndex };
            const candidateRecords = flattenRowsToFlightRecords([savedRow]);
            assertNoDuplicateFlightNumbers([...flightRecords, ...candidateRecords]);
            const nextRecords = [...flightRecords, ...candidateRecords];
            const nextMods = modifications;
            const nextRows = buildPatternRowsFromRecords(nextRecords, nextMods);
            const baseDraft = draftState ?? {
              baseRows: displayRows as unknown as ParsedRow[],
              baseRecords: flightRecords,
              baseModifications: modifications,
              records: [],
              modifications: [],
            };
            setCachedSeasonData(activeSeason.id, {
              rows: nextRows,
              records: nextRecords,
              modifications: nextMods,
              seasonDataVersion: activeSeason.dataVersion,
            });
            useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
              seasonId: activeSeason.id,
              affectedIds: candidateRecords.map((record) => record.id),
              rows: nextRows,
              records: candidateRecords,
              modifications: nextMods,
            });
            applySeasonData(nextRows, nextRecords, nextMods);
            setDraftState({
              ...baseDraft,
              records: [...baseDraft.records, ...candidateRecords],
            });
            setIsNewFlightOpen(false);
          } catch (err) {
            console.error(err);
            void showAlert({ title: 'Add Flight Failed', message: (err as Error).message, tone: 'error' });
          } finally {
            finishSeasonalMutation(mutation);
          }
        }}
      />

      {dialogNode}

    </div>
  );
}
