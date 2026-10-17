'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { parseSeasonalSchedule, enrichRows } from '@/lib/parser';
import {
  findSeasonByCode,
  getSeasons,
  getSeasonalExportSnapshot,
  loadSeasonWorkspaceWindow,
  type RemoteSeasonalExportSnapshot,
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
  compactDraftModifications,
  countHistoryEntryLegs,
  draftAddedRecordsForCommit,
  partitionDraftDeleteTargets,
  revertFlightRecordHistoryList,
  revertModificationHistoryMap,
} from '@/lib/detailedScheduleState';
import { buildImportProgress, buildLoadProgress, type ImportProgress, type LoadProgress } from '@/lib/importProgress';
import { buildSeasonDisplayLabel, getDirtyImportGuard } from '@/lib/importSeasonRules';
import {
  buildSeasonalDraftImportRecoveryReceipt,
  clearLegacySeasonalImportReceipts,
  clearSeasonalDraftImportRecoveryReceipt,
  draftImportResponseToPreview,
  hasLegacySeasonalImportPendingReceipt,
  loadSeasonalDraftImportRecoveryReceipt,
  markSeasonalDraftImportRecoveryCommitted,
  persistSeasonalDraftImportRecoveryReceipt,
  prepareSeasonalDraftImportStageInput,
  type SeasonalDraftImportCommittedResult,
  type SeasonalDraftImportPreviewResult,
  type SeasonalDraftImportRecoveryReceipt,
  type SeasonalDraftImportResponse,
  type SeasonalDraftImportStageInput,
} from '@/lib/seasonalDraftImportContract';
import { getCurrentOperatorAccess } from '@/lib/operatorUserManagement';
import {
  canCommitSeasonalImportPreview,
  type SeasonalImportPreviewState,
} from '@/lib/seasonalImportPreview';
import {
  buildSeasonalAvailableRecordIds,
  createSeasonalFileActionController,
  getSeasonalFileActionBlock,
  reconcileSeasonalSelection,
  type SeasonalFileActionBlock,
  type SeasonalFileActionInvalidation,
  type SeasonalFileActionOperation,
  type SeasonalMutationOperation,
} from '@/lib/seasonalFileActionGuard';
import {
  getCachedSeasons,
  publishSeasonWorkspaceChanged,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  assertNoDuplicateFlightNumbersForEffectiveRecords,
  findDuplicateFlightNumberViolations,
  flattenRowsToFlightRecords,
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
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from '@/lib/operatorSessionCacheRegistry';
import { revalidateSeasonWorkspaceAfterMutation } from '@/lib/seasonWorkspaceWindowCoordinator';
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
import SeasonalImportPreviewDialog from './components/SeasonalImportPreviewDialog';
import LoadingStatusPanel from './components/LoadingStatusPanel';
import SeasonalPublishModal from './components/SeasonalPublishModal';
import SeasonalVersionHistoryModal from './components/SeasonalVersionHistoryModal';
import { isSeasonalPlanningV1Enabled, seasonalDraftToFlightRecord, type SeasonalDraftChangeInput, type SeasonalDraftRecord } from '@/lib/seasonalPlanningContract';
import {
  applyModificationsToFlightRecords,
  buildAuthoritativeDraftUndoChanges,
  createInitialDraftSaveState,
  executeSeasonalPlanningDraftSave,
  isDraftWorkspaceNotFoundError,
  loadFullSeasonalDraftRecords,
  retrySeasonalPlanningDraft,
  seasonalDraftExportSnapshotToFlightRecords,
  type SeasonalDraftSaveState,
} from '@/lib/seasonalPlanningSaveManager';
import {
  applySeasonalDraftChangesV1,
  cancelSeasonalDraftImportV1,
  commitSeasonalDraftImportV1,
  getSeasonalDraftExportSnapshotV1,
  getSeasonalDraftWindowV1,
  getSeasonalDraftImportStatusV1,
  stageSeasonalDraftImportV1,
} from '@/lib/remoteStore';
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
import { formatUiError, formatUiFieldLabel, formatUiValue } from '@/lib/uiDisplayText';

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
  const message = formatUiError(error, 'Lỗi xuất dữ liệu không xác định.');
  if (/version|data version|phiên bản/i.test(message)) return `Phiên bản: ${message}`;
  if (/snapshot|array|totalCount|truncated|season mismatch|bản lưu/i.test(message)) return `Bản lưu: ${message}`;
  return `Máy chủ: ${message}`;
}

function countSeasonalDraftChanges(draft: SeasonalScheduleDraftState | null): number {
  return (draft?.records.length ?? 0) + (draft?.modifications.length ?? 0);
}

function getLoadErrorMessage(error: unknown): string {
  return formatUiError(error, 'Không thể tải dữ liệu lịch bay từ máy chủ.');
}

function formatSeasonalFileActionBlockMessage(block: SeasonalFileActionBlock): string {
  switch (block.code) {
    case 'busy':
      return 'Một thao tác Lịch mùa khác đang được xử lý.';
    case 'draft':
      return 'Lưu hoặc hủy thay đổi bản nháp Lịch mùa trước khi thực hiện thao tác tệp.';
    case 'stale-selection':
      return 'Một số chuyến bay đã chọn không còn khả dụng. Vui lòng kiểm tra lại lựa chọn trước khi xuất.';
    case 'no-selection':
      return 'Vui lòng chọn ít nhất một chuyến bay trước khi xuất dữ liệu.';
    default:
      return formatUiError(block.message, 'Thao tác tệp Lịch mùa bị chặn.');
  }
}

function formatImportStatusLabel(status: string | null | undefined): string {
  if (!status) return 'không khả dụng';
  const formatted = formatUiValue(status, 'status');
  if (formatted !== status) return formatted;
  switch (status.toLowerCase()) {
    case 'validated':
      return 'Đã xác thực';
    case 'committed':
      return 'Đã hoàn tất';
    case 'terminal':
      return 'Đã kết thúc';
    case 'aborted':
      return 'Đã hủy';
    case 'expired':
      return 'Đã hết hạn';
    case 'staging':
      return 'Đang chuẩn bị';
    case 'refreshing':
      return 'Đang làm mới';
    default:
      return status;
  }
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
  const pendingImportAttemptRef = useRef<SeasonalDraftImportRecoveryReceipt | null>(null);
  const pendingCommittedImportRef = useRef<SeasonalDraftImportCommittedResult | null>(null);
  const [canWriteSeasonal, setCanWriteSeasonal] = useState(false);
  const [legacyPendingReceiptFound, setLegacyPendingReceiptFound] = useState(false);
  const currentOperatorUserIdRef = useRef<string>('');
  const restoreFileActionOpRef = useRef<SeasonalFileActionOperation | null>(null);
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
  const [draftSaveState, setDraftSaveState] = useState<SeasonalDraftSaveState>(() => createInitialDraftSaveState(0));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Đang tải danh sách mùa...', 10, 'Đang chuẩn bị lịch mùa')
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null);
  const [pendingImportAttempt, setPendingImportAttemptState] = useState<SeasonalDraftImportRecoveryReceipt | null>(null);
  const [pendingCommittedImport, setPendingCommittedImportState] = useState<SeasonalDraftImportCommittedResult | null>(null);
  const [importPreviewState, setImportPreviewState] = useState<SeasonalImportPreviewState>({ kind: 'idle' });
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
  const setPendingImportAttempt = useCallback((attempt: SeasonalDraftImportRecoveryReceipt | null) => {
    pendingImportAttemptRef.current = attempt;
    setPendingImportAttemptState(attempt);
  }, []);
  const setPendingCommittedImport = useCallback((result: SeasonalDraftImportCommittedResult | null) => {
    pendingCommittedImportRef.current = result;
    setPendingCommittedImportState(result);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    getCurrentOperatorAccess()
      .then((access) => {
        if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch) || !access.userId) return;
        currentOperatorUserIdRef.current = access.userId;
        setCanWriteSeasonal(access.permissions.has('seasonal.write'));
        setLegacyPendingReceiptFound(hasLegacySeasonalImportPendingReceipt(sessionStorage));
        const receipt = loadSeasonalDraftImportRecoveryReceipt(sessionStorage, { ownerUserId: access.userId });
        if (!receipt) return;
        setPendingImportAttempt(receipt);
        if (receipt.status === 'committed' && receipt.committedResult) {
          setPendingCommittedImport(receipt.committedResult);
          setImportPreviewState({ kind: 'committed-refresh-pending', result: receipt.committedResult });
        }
      })
      .catch((err) => {
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
          console.warn('Failed to load operator permissions:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setPendingCommittedImport, setPendingImportAttempt]);
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
  const fetchProgress = fetchingServerData ? 'Đang tải dữ liệu máy chủ' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const draftChangeCount = countSeasonalDraftChanges(draftState);
  const hasDraftChanges = draftChangeCount > 0;

  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [restoreFileActionToken, setRestoreFileActionToken] = useState<number | null>(null);
  const [historyDraftTokens, setHistoryDraftTokens] = useState<{ revision: string | number; epoch: string | null }>({ revision: 0, epoch: null });
  const latestDraftRevisionRef = useRef<number | string>(0);
  const latestDraftEpochRef = useRef<string | null>(null);


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
    let detail = '';
    switch (invalidation.code) {
      case 'season-changed':
        detail = 'Mùa đang chọn đã thay đổi trong khi thao tác tệp đang diễn ra.';
        break;
      case 'draft-changed':
        detail = 'Bản nháp Lịch mùa đã thay đổi trong khi thao tác tệp đang diễn ra.';
        break;
      case 'operation-replaced':
        detail = 'Thao tác tệp Lịch mùa này không còn là phiên bản hiện tại.';
        break;
      default:
        detail = formatUiError(invalidation.message, 'Thao tác tệp Lịch mùa bị gián đoạn.');
        break;
    }
    void showAlert({
      title: action === 'import' ? 'Nhập tệp bị gián đoạn' : 'Không thể xuất dữ liệu',
      message: `${detail} Vui lòng kiểm tra lại mùa hiện tại và thử lại.`,
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

  const handleRetryDraftSave = useCallback(async () => {
    if (!activeSeason || draftSaveState.status !== 'error') return;
    setDraftSaveState((prev) => ({ ...prev, status: 'saving', error: null }));
    const saveResult = await retrySeasonalPlanningDraft(draftSaveState);
    if (saveResult.result) {
      setDraftSaveState(saveResult.state);
      if (saveResult.result.status === 'saved' && saveResult.result.receipt) {
        latestDraftRevisionRef.current = saveResult.result.receipt.revision;
        try {
          const draftData = await loadFullSeasonalDraftRecords(activeSeason.id, getSeasonalDraftWindowV1);
          setFlightRecords(draftData.records);
          const nextRows = buildPatternRowsFromRecords(draftData.records, modifications);
          setDisplayRows(enrichRows(nextRows));
          applySeasonData(nextRows, draftData.records, modifications);
        } catch {
          // Keep optimistic if reload window transiently fails
        }
      }
    }
  }, [activeSeason, applySeasonData, draftSaveState, modifications, setDraftSaveState]);

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
    const startDraftRevision = latestDraftStateRef.current.revision;
    const requestIsCurrent = () => !requestGuard || (
      fetchServerDataRequestRef.current === requestGuard.requestId &&
      latestRouteWindowRef.current.seasonId === requestGuard.seasonId &&
      latestRouteWindowRef.current.windowKey === requestGuard.windowKey &&
      !latestDraftStateRef.current.hasDraftChanges &&
      latestDraftStateRef.current.revision === startDraftRevision &&
      latestDraftStateRef.current.value === null
    );
    if (isSeasonalPlanningV1Enabled()) {
      setLoadProgress(buildLoadProgress('Đang tải không gian làm việc bản nháp', 25, season.seasonCode));
      try {
        const draftData = await loadFullSeasonalDraftRecords(season.id, getSeasonalDraftWindowV1);
        if (!requestIsCurrent()) return;
        loadedWindowKeyRef.current = windowKey;
        latestDraftRevisionRef.current = draftData.revision;
        latestDraftEpochRef.current = draftData.epoch;
        setDraftSaveState(createInitialDraftSaveState(draftData.revision));
        const records = draftData.records;
        const mods = new Map<string, FlightModification>();
        const rows = buildPatternRowsFromRecords(records, mods);
        setLoadProgress(buildLoadProgress('Đang kết xuất lịch mùa', 80, `${records.length} chuyến bay`));
        setCachedSeasonData(season.id, {
          rows,
          records,
          modifications: mods,
          seasonDataVersion: season.dataVersion,
        });
        const syncMeta: LocalSyncMeta = {
          seasonId: season.id,
          localRevision: Number(draftData.revision) || 0,
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: season.dataVersion ?? 0,
          syncStatus: 'synced',
        };
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: season.id,
          season,
          rows,
          records,
          modifications: mods,
          syncMeta,
          windowKey,
        });
        setActiveSeason(season);
        applySeasonData(rows, records, mods);
        setModHistory([]);
        setDraftState(null);
        setSyncSummary({
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
        });
        publishSeasonWorkspaceChanged({
          seasonId: season.id,
          localRevision: syncMeta.localRevision,
          source: 'server-window',
          syncMeta,
        });
        return;
      } catch (err) {
        if (!isDraftWorkspaceNotFoundError(err)) {
          throw err;
        }
      }
    }
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
    setLoadProgress(buildLoadProgress('Đang tải không gian làm việc từ máy chủ', 25, season.seasonCode));
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
      setLoadProgress(buildLoadProgress('Đang kết xuất lịch mùa', 80, `${records.length} chuyến bay`));
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
      if (isSeasonalPlanningV1Enabled()) {
        try {
          const draftWindow = await getSeasonalDraftWindowV1({ seasonId: season.id, pageSize: 1 });
          latestDraftRevisionRef.current = draftWindow.revision;
          latestDraftEpochRef.current = draftWindow.epoch;
          setDraftSaveState(createInitialDraftSaveState(draftWindow.revision));
        } catch {
          // Draft window not yet initialized
        }
      }
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
    onRefresh: async (event) => {
      if (event.refreshMode === 'revalidate' && activeSeason && !hasDraftChanges) {
        await loadSeasonRows(activeSeason, true);
        return;
      }
      refreshSeasonalWindow();
    },
  });

  // Load seasons on mount
  useEffect(() => {
    (async () => {
      try {
        setLoadError(null);
        setLoadProgress(buildLoadProgress('Đang tải danh sách mùa...', 10, 'Kiểm tra lịch bay hiện có'));
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
    if (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges)) {
      void showAlert({
        title: 'Bản nháp chưa được lưu',
        message: 'Không thể chuyển mùa khi có thay đổi bản nháp đang lưu hoặc chưa được xác nhận bởi máy chủ.',
        tone: 'warning',
      });
      return;
    }
    const found = seasons.find(s => s.id === seasonId);
    if (!found) return;
    setSelectedRecordIds(new Set());
    setActiveSeason(found);
    setPage(0);
    sessionStorage.setItem('activeSeasonId', seasonId);
    setLoading(true);
    setLoadError(null);
    setLoadProgress(buildLoadProgress('Đang tải danh sách mùa...', 10, found.seasonCode));
    try {
      await loadSeasonRows(found);
    } catch (err) {
      console.error('Load error:', err);
      setLoadError(getLoadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [draftSaveState.hasUnconfirmedChanges, draftSaveState.status, loadSeasonRows, seasons, setActiveSeason, showAlert]);

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
    () => materializeEffectiveSeasonalLegs(flightRecords, modifications),
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
    const isPlanning = isSeasonalPlanningV1Enabled();
    const exportSelection: SeasonalExportSelection = {
      seasonId: exportSeason.id,
      dataVersion: isPlanning
        ? Number(latestDraftRevisionRef.current ?? 0)
        : (exportSeason.dataVersion ?? 0),
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
        title: initialBlock.code === 'no-selection' ? 'Chọn chuyến bay để xuất' : 'Không thể xuất dữ liệu',
        message: initialBlock.code === 'no-selection'
          ? 'Tích chọn các dòng chuyến bay cần xuất. Để xuất toàn bộ lịch mùa, hãy chọn tất cả các dòng.'
          : formatSeasonalFileActionBlockMessage(initialBlock),
        tone: initialBlock.code === 'no-selection' ? 'info' : 'warning',
      });
      return;
    }
    const operation = beginSeasonalFileAction('export');
    if (!operation) {
      void showAlert({
        title: 'Không thể xuất dữ liệu',
        message: 'Một thao tác Lịch mùa khác đang được xử lý.',
        tone: 'warning',
      });
      return;
    }
    try {
      setIsExporting(true);
      let exportSnapshot: RemoteSeasonalExportSnapshot;
      if (isPlanning) {
        let epoch = latestDraftEpochRef.current;
        let revision = latestDraftRevisionRef.current;
        if (!epoch) {
          const draftWindow = await getSeasonalDraftWindowV1({ seasonId: exportSeason.id, pageSize: 1 });
          epoch = draftWindow.epoch;
          revision = draftWindow.revision;
          latestDraftEpochRef.current = epoch;
          latestDraftRevisionRef.current = revision;
        }
        const draftSnapshot = await getSeasonalDraftExportSnapshotV1({
          seasonId: exportSeason.id,
          expectedEpoch: epoch,
          expectedRevision: revision,
        });
        const records = seasonalDraftExportSnapshotToFlightRecords(draftSnapshot);
        exportSnapshot = {
          seasonId: draftSnapshot.seasonId,
          seasonCode: draftSnapshot.seasonCode,
          dataVersion: Number(draftSnapshot.draftRevision),
          totalCount: draftSnapshot.totalCount,
          sourceRowCount: draftSnapshot.totalCount,
          serverHighWater: Number(draftSnapshot.serverHighWater),
          truncated: false,
          records,
          modifications: new Map(),
        };
        exportSelection.dataVersion = exportSnapshot.dataVersion;
      } else {
        exportSnapshot = await getSeasonalExportSnapshot({
          seasonId: exportSeason.id,
          expectedDataVersion: exportSelection.dataVersion,
        });
      }
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
        const flightLabel = issueLeg ? `${issueLeg.flightNumber} vào ngày ${issueLeg.date}: ` : '';
        const issueLabel = issue?.code ? formatUiFieldLabel(issue.code) : 'Lựa chọn xuất';
        let detailMessage = '';
        switch (issue?.code) {
          case 'season-mismatch':
            detailMessage = 'Mùa được chọn không khớp với mùa của bản lưu dữ liệu.';
            break;
          case 'version-mismatch':
            detailMessage = 'Phiên bản dữ liệu được chọn không khớp với phiên bản máy chủ.';
            break;
          case 'zero-selection':
            detailMessage = 'Không có chuyến bay hiệu lực nào trong lựa chọn để xuất.';
            break;
          case 'unknown-record-id':
            detailMessage = `Chuyến bay ${issue.recordId ?? ''} không tồn tại trong bản lưu máy chủ.`;
            break;
          default:
            detailMessage = formatUiError(issue?.message, 'Lựa chọn xuất không hợp lệ.');
            break;
        }
        void showAlert({
          title: 'Không thể xuất dữ liệu',
          message: `${issueLabel}: ${flightLabel}${detailMessage}`,
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
        void showAlert({ title: 'Không thể xuất dữ liệu', message: formatSeasonalFileActionBlockMessage(snapshotBlock), tone: 'warning' });
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
          title: 'Không thể xuất dữ liệu',
          message: `Trùng số hiệu chuyến bay ${violations[0].flightNumber} vào ngày ${violations[0].date}.`,
          tone: 'error',
        });
        return;
      }
      const exportValidation = validateFlightLegsForSeasonalExport(exportLegs);
      if (!exportValidation.valid) {
        const issue = exportValidation.issues[0];
        const issueLeg = exportLegs.find((leg) => leg.id === issue.legId);
        const flightLabel = issueLeg ? `${issueLeg.flightNumber} vào ngày ${issueLeg.date}: ` : '';
        const issueLabel = formatUiFieldLabel(issue.code);
        let detailMessage = '';
        switch (issue.code) {
          case 'date-metadata-mismatch':
            detailMessage = 'Ngày bay không khớp với dữ liệu gốc của chuyến bay.';
            break;
          case 'invalid-linked-pair':
            detailMessage = 'Cặp chuyến bay liên kết không hợp lệ hoặc thiếu thông tin đối ứng.';
            break;
          default:
            detailMessage = formatUiError(issue.message, 'Dữ liệu chuyến bay không hợp lệ để xuất.');
            break;
        }
        void showAlert({
          title: 'Không thể xuất dữ liệu',
          message: `${issueLabel}: ${flightLabel}${detailMessage}`,
          tone: 'error',
        });
        return;
      }
      if (!canonicalExport.validation.valid) {
        const issue = canonicalExport.validation.issues[0];
        const issueLabel = issue?.code ? formatUiFieldLabel(issue.code) : 'Kiểm tra khứ hồi';
        let detail = issue?.message ?? 'Xuất lịch mùa không bảo toàn định dạng hai chiều.';
        if (issue?.code === 'missing-occurrence') {
          detail = `Thiếu ${issue.count} lượt bay: ${issue.signature}`;
        } else if (issue?.code === 'extra-occurrence') {
          detail = `Dư ${issue.count} lượt bay: ${issue.signature}`;
        } else if (issue?.message) {
          detail = formatUiError(issue.message, 'Xuất lịch mùa không bảo toàn định dạng hai chiều.');
        }
        void showAlert({
          title: 'Không thể xuất dữ liệu',
          message: `Khứ hồi (${issueLabel}): ${detail}`,
          tone: 'error',
        });
        return;
      }
      if (canonicalExport.rows.length === 0) {
        void showAlert({ title: 'Không thể xuất dữ liệu', message: 'Lựa chọn xuất: Dữ liệu xuất sẽ tạo tệp trống.', tone: 'error' });
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
      void showAlert({ title: 'Không thể xuất dữ liệu', message: describeSeasonalExportFailure(err), tone: 'error' });
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
      let nextMods = revertModificationHistoryMap(modifications, entriesToUndo);
      let nextRecords = revertFlightRecordHistoryList(flightRecords, entriesToUndo);
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
      let nativeSyncMeta: LocalSyncMeta | null = null;
      if (isSeasonalPlanningV1Enabled()) {
        const undoChanges = (entriesToUndo as Array<ModHistoryEntry & { draftUndoChanges?: SeasonalDraftChangeInput[] }>)
          .flatMap((entry) => entry.draftUndoChanges ?? []);

        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: activeSeason.id,
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
        if (saveResult.result.receipt) {
          latestDraftRevisionRef.current = saveResult.result.receipt.revision;
          try {
            const draftData = await loadFullSeasonalDraftRecords(activeSeason.id, getSeasonalDraftWindowV1);
            nextRecords = draftData.records;
          } catch {
            // Keep optimistic records if reload transiently fails
          }
        }
        nextMods = new Map();
        nativeSyncMeta = {
          seasonId: activeSeason.id,
          localRevision: Number(saveResult.result.receipt?.revision ?? latestDraftRevisionRef.current),
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: activeSeason.dataVersion ?? 0,
          syncStatus: 'synced',
        };
      } else {
        nativeSyncMeta = await runNativeScheduleMutation(
          activeSeason.id,
          Array.from(undoRecords.values()),
          Array.from(undoDeletedRecords.values()),
          Array.from(undoMods.values()),
          {
            id: `LOCAL_UNDO_${undoTimestamp}`,
            timestamp: undoTimestamp,
            description: `Đã hoàn tác: ${targetEntry.description}`,
          },
          [],
          'seasonal'
        );
      }
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
      const nextRecordIds = new Set(nextRecords.map((record) => record.id));
      useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
        seasonId: activeSeason.id,
        affectedIds,
        records: nextRecords,
        deletedIds: flightRecords.filter((record) => !nextRecordIds.has(record.id)).map((record) => record.id),
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
      void showAlert({ title: 'Hoàn tác thất bại', message: formatUiError(err), tone: 'error' });
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
    if (!activeSeason || !draftState) return;
    const baseRecordIds = new Set(draftState.baseRecords.map((record) => record.id));
    const addedRecords = draftAddedRecordsForCommit(flightRecords, baseRecordIds, draftState.modifications);
    const regularMods = compactDraftModifications(draftState.modifications, baseRecordIds);
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
      if (isSeasonalPlanningV1Enabled()) {
        const appliedBaseRecords = applyModificationsToFlightRecords(draftState.baseRecords, regularMods);
        const currentRecords = [...appliedBaseRecords, ...addedRecords];
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: activeSeason.id,
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
          throw new Error(planningResult.error || 'Lỗi lưu bản nháp mùa lên server.');
        }
        if (planningResult.receipt) {
          latestDraftRevisionRef.current = planningResult.receipt.revision;
        }
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
        const nextRows = buildPatternRowsFromRecords(effectiveRecords, new Map());
        applySeasonData(nextRows, effectiveRecords, new Map());
        setCachedSeasonData(activeSeason.id, {
          rows: nextRows,
          records: effectiveRecords,
          modifications: new Map(),
          seasonDataVersion: activeSeason.dataVersion,
        });
        const committedIds = Array.from(committedRecordsById.keys());
        const planningSyncMeta: LocalSyncMeta = {
          seasonId: activeSeason.id,
          localRevision: Number(latestDraftRevisionRef.current),
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: activeSeason.dataVersion ?? 0,
          syncStatus: 'synced',
        };
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: activeSeason.id,
          affectedIds: committedIds,
          rows: nextRows,
          records: effectiveRecords.filter((record) => committedRecordsById.has(record.id)),
          deletedIds: committedIds.filter((id) => committedRecordsById.get(id)?.status === 'deleted'),
          syncMeta: planningSyncMeta,
        });
        publishSeasonalWorkspaceChange(activeSeason.id, planningSyncMeta.localRevision, committedIds, planningSyncMeta);
        setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([planningHistoryEntry, ...modHistory])));
        setDraftState(null);
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season: activeSeason,
          module: 'seasonal',
          operation: description,
          beforeRecords: draftState.baseRecords,
          afterRecords: effectiveRecords,
          beforeModifications: draftState.baseModifications,
          afterModifications: modifications,
          targetRecordIds,
        }));
        return;
      }

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
    applySeasonData,
    beginSeasonalMutation,
    draftState,
    finishSeasonalMutation,
    flightRecords,
    handleDiscardSeasonalDraft,
    modHistory,
    modifications,
    publishSeasonalWorkspaceChange,
    setDraftState,
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
    blocked: isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges),
    reason: draftSaveState.status === 'saving'
      ? 'Đang lưu bản nháp kế hoạch mùa...'
      : draftSaveState.status === 'error'
        ? 'Lưu bản nháp kế hoạch mùa thất bại, có thay đổi chưa xác nhận'
        : 'Có thay đổi bản nháp kế hoạch mùa chưa xác nhận',
    quiet: false,
    blockingUi: true,
  });
  const handleOpenPublishModal = useCallback(async () => {
    if (syncInProgress || fileActionControllerRef.current.isFileActionActive()) return;
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
  }, [commitDraftBeforeSave, draftSaveState.hasUnconfirmedChanges, draftSaveState.status, hasDraftChanges, showAlert, syncInProgress]);

  const handleDraftRestored = useCallback(async () => {
    if (!activeSeason) throw new Error('Season context unavailable during restore reload');
    try {
      const draftData = await loadFullSeasonalDraftRecords(activeSeason.id, getSeasonalDraftWindowV1);
      latestDraftRevisionRef.current = draftData.revision;
      latestDraftEpochRef.current = draftData.epoch;
      setDraftSaveState(createInitialDraftSaveState(draftData.revision));
      setHistoryDraftTokens({
        revision: draftData.revision,
        epoch: draftData.epoch,
      });
      const patternRows = buildPatternRowsFromRecords(draftData.records, new Map());
      applySeasonData(patternRows, draftData.records, new Map());
      setModifications(new Map());
      setDraftState(null);
      setModHistory([]);
      publishSeasonalWorkspaceChange(activeSeason.id, Number(draftData.revision), [], {
        seasonId: activeSeason.id,
        localRevision: Number(draftData.revision),
        pendingCount: 0,
        lastLocalChangeAt: Date.now(),
        baseServerVersion: activeSeason.dataVersion ?? 0,
        syncStatus: 'synced',
      });
      void showAlert({
        title: 'Khôi phục Thành công',
        message: `Đã khôi phục thành công dữ liệu lịch bay mùa ${activeSeason.seasonCode || activeSeason.code} vào bản nháp. Dữ liệu đã sẵn sàng để kiểm tra hoặc công bố lại.`,
        tone: 'success',
      });
    } catch (err: unknown) {
      void showAlert({
        title: 'Lỗi nạp lại bản nháp',
        message: formatUiError(err),
        tone: 'error',
      });
      throw err;
    }
  }, [activeSeason, applySeasonData, publishSeasonalWorkspaceChange, setDraftState, showAlert]);

  const handleBeginRestore = useCallback(() => {
    if (restoreFileActionOpRef.current && activeFileActionToken === restoreFileActionOpRef.current.token) {
      setRestoreFileActionToken(restoreFileActionOpRef.current.token);
      return true;
    }
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) return false;
    const op = beginSeasonalFileAction('import');
    if (!op) return false;
    restoreFileActionOpRef.current = op;
    setRestoreFileActionToken(op.token);
    return true;
  }, [activeFileActionToken, beginSeasonalFileAction, isSeasonalFileActionBusyNow]);

  const handleFinishRestore = useCallback(() => {
    if (restoreFileActionOpRef.current) {
      finishSeasonalFileAction(restoreFileActionOpRef.current);
      restoreFileActionOpRef.current = null;
      setRestoreFileActionToken(null);
    }
  }, [finishSeasonalFileAction]);

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
          title: 'Xóa cặp chuyến bay liên kết',
          message: `${flightLabel} đang liên kết với ${deletionTargets.counterpartIds.length} lượt bay đối ứng còn hiệu lực.\n\nChọn xóa toàn bộ cặp chuyến bay hay chỉ xóa chặng bay đã chọn.`,
          tone: 'warning',
          choices: [
            { value: 'pair', label: `Xóa toàn bộ cặp chuyến bay (${deletionTargets.pairIds.length})`, tone: 'warning' },
            { value: 'selected', label: `Chỉ xóa chặng đã chọn (${deletionTargets.selectedIds.length})` },
            { value: 'cancel', label: 'Hủy' },
          ],
        });
        if (choice === 'pair') targetIds = deletionTargets.pairIds;
        else if (choice === 'selected') targetIds = deletionTargets.selectedIds;
        else return;
      } else {
        const shouldDelete = await showConfirm({
          title: 'Xóa nhóm chuyến bay',
          message: `Xóa ${ids.length} lượt bay của ${flightLabel}?`,
          tone: 'warning',
          confirmLabel: 'Xóa',
        });
        if (!shouldDelete) return;
      }

      if (isSeasonalPlanningV1Enabled()) {
        const deletedRecords = flightRecords.filter((r) => targetIds.includes(r.id));
        let effectiveRecords = flightRecords.filter((r) => !targetIds.includes(r.id));
        const historyTimestamp = Date.now();
        const historyEntry: ModHistoryEntry = {
          id: `LOCAL_DEL_${historyTimestamp}`,
          timestamp: historyTimestamp,
          description: `Đã xóa ${targetIds.length} lượt bay của ${flightLabel}`,
          changes: [],
          recordChanges: deletedRecords.map((record) => ({
            recordId: record.id,
            previousRecord: record,
            newRecord: null,
          })),
        };
        const nextRows = buildPatternRowsFromRecords(effectiveRecords, new Map());
        applySeasonData(nextRows, effectiveRecords, new Map());
        setCachedSeasonData(activeSeason.id, {
          rows: nextRows,
          records: effectiveRecords,
          modifications: new Map(),
          seasonDataVersion: activeSeason.dataVersion,
        });
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: activeSeason.id,
          affectedIds: targetIds,
          deletedIds: targetIds,
          rows: nextRows,
          records: effectiveRecords,
          modifications: new Map(),
        });
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: activeSeason.id,
          currentRecords: effectiveRecords,
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
          try {
            const draftData = await loadFullSeasonalDraftRecords(activeSeason.id, getSeasonalDraftWindowV1);
            effectiveRecords = draftData.records;
            const refreshedRows = buildPatternRowsFromRecords(draftData.records, new Map());
            applySeasonData(refreshedRows, draftData.records, new Map());
          } catch {
            // Keep optimistic records if reload transiently fails
          }
        }
        if (saveResult.result.status === 'saved' && saveResult.result.receipt) {
          const draftUndoChanges = buildAuthoritativeDraftUndoChanges(saveResult.result.receipt, flightRecords);
          setModHistory((prev) => trimUiUndoEntries(filterUiUndoEntriesForSession([{ ...historyEntry, draftUndoChanges }, ...prev])));
        }
      } else {
        const baseRecordIds = new Set((draftState?.baseRecords ?? flightRecords).map((record) => record.id));
        const { draftAddedIds, persistedIds } = partitionDraftDeleteTargets(targetIds, baseRecordIds);
        const localDeleteIds = new Set(draftAddedIds);
        const deleteMods = persistedIds.map((id) => ({ legId: id, action: 'deleted' as const }));
        const nextRecords = localDeleteIds.size === 0
          ? flightRecords
          : flightRecords.filter((record) => !localDeleteIds.has(record.id));
        const nextMods = new Map(modifications);
        deleteMods.forEach((mod) => nextMods.set(mod.legId, mod));
        localDeleteIds.forEach((id) => nextMods.delete(id));
        const baseDraft = draftState ?? {
          baseRows: displayRows as unknown as ParsedRow[],
          baseRecords: flightRecords,
          baseModifications: modifications,
          records: [],
          modifications: [],
        };
        const nextRows = buildPatternRowsFromRecords(nextRecords, nextMods);
        applySeasonData(nextRows, nextRecords, nextMods);
        setCachedSeasonData(activeSeason.id, {
          rows: nextRows,
          records: nextRecords,
          modifications: nextMods,
          seasonDataVersion: activeSeason.dataVersion,
        });
        useSeasonWorkspaceStore.getState().patchSeasonWorkspace({
          seasonId: activeSeason.id,
          affectedIds: [...getAffectedIdsFromSeasonalModifications(deleteMods), ...draftAddedIds],
          deletedIds: draftAddedIds,
          rows: nextRows,
          records: nextRecords,
          modifications: nextMods,
        });
        setDraftState({
          ...baseDraft,
          records: baseDraft.records.filter((record) => !localDeleteIds.has(record.id)),
          modifications: [...baseDraft.modifications, ...deleteMods],
        });
      }
      setSelectedRecordIds((prev) => {
        const next = new Set(prev);
        targetIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (err) {
      void showAlert({ title: 'Xóa thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      finishSeasonalMutation(mutation);
    }
  }, [activeDisplayLegs, activeSeason, applySeasonData, beginSeasonalMutation, displayRows, draftState, finishSeasonalMutation, flightRecords, modifications, setDraftState, showAlert, showChoice, showConfirm, syncInProgress]);

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
      const counterpartText = counterpartCount > 0 ? ` và ${counterpartCount} bản ghi đối ứng` : '';
      const shouldUnlink = await showConfirm({
        title: 'Hủy liên kết nhóm chuyến bay',
        message: `Hủy liên kết ${linkedIds.length} lượt bay của ${flightLabel}${counterpartText}?\nThao tác này áp dụng cho toàn bộ dòng Lịch mùa. Dùng Lịch chi tiết nếu chỉ muốn áp dụng cho khoảng thời gian hẹp hơn.`,
        tone: 'warning',
        confirmLabel: 'Hủy liên kết',
      });
      if (!shouldUnlink) return;

      const historyTimestamp = Date.now();
      const historyEntry = buildFlightRecordHistoryEntry({
        id: `LOCAL_RECORD_${historyTimestamp}`,
        timestamp: historyTimestamp,
        description: `Đã hủy liên kết ${result.updatedRecords.length} lượt bay của ${flightLabel}`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      let nativeSyncMeta: LocalSyncMeta | null = null;
      if (isSeasonalPlanningV1Enabled()) {
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: activeSeason.id,
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
          }
        }
        nativeSyncMeta = {
          seasonId: activeSeason.id,
          localRevision: Number(saveResult.result.receipt?.revision ?? latestDraftRevisionRef.current),
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: activeSeason.dataVersion ?? 0,
          syncStatus: 'synced',
        };
      } else {
        nativeSyncMeta = await runNativeScheduleMutation(
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
      }
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
      void showAlert({ title: 'Hủy liên kết thất bại', message: formatUiError(err), tone: 'error' });
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
        description: `Đã liên kết ${result.updatedRecords.length} lượt bay ${candidate.linkType === 'overnight' ? 'qua đêm' : 'trong ngày'}`,
        beforeRecords: flightRecords,
        afterRecords: result.records,
      });
      let nativeSyncMeta: LocalSyncMeta | null = null;
      if (isSeasonalPlanningV1Enabled()) {
        setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
        const saveResult = await executeSeasonalPlanningDraftSave({
          seasonId: activeSeason.id,
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
          }
        }
        nativeSyncMeta = {
          seasonId: activeSeason.id,
          localRevision: Number(saveResult.result.receipt?.revision ?? latestDraftRevisionRef.current),
          pendingCount: 0,
          lastLocalChangeAt: Date.now(),
          baseServerVersion: activeSeason.dataVersion ?? 0,
          syncStatus: 'synced',
        };
      } else {
        nativeSyncMeta = await runNativeScheduleMutation(
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
      }
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
      void showAlert({ title: 'Liên kết thất bại', message: formatUiError(err), tone: 'error' });
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
        title: result.status === 'synced' ? 'Lưu hoàn tất' : 'Lưu thất bại',
        message: result.message ?? 'Không có thay đổi cục bộ nào cần lưu.',
        tone: result.status === 'synced' ? 'success' : 'error',
      });
    } catch (err) {
      void showAlert({ title: 'Lưu thất bại', message: formatUiError(err), tone: 'error' });
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
      void showAlert({ title: 'Tải dữ liệu thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [activeSeason, debouncedFilters.dateFrom, debouncedFilters.dateTo, debouncedFilters.flight, debouncedFilters.route, fetchingServerData, hasDraftChanges, loadSeasonRows, showAlert, syncInProgress]);

  // Import handler
  const handleImportClick = useCallback(() => {
    if (!isSeasonalPlanningV1Enabled()) {
      void showAlert({
        title: 'Nhập tệp không khả dụng',
        message: 'Cần bật không gian Planning để nhập lịch mùa.',
        tone: 'warning',
      });
      return;
    }
    if (!canWriteSeasonal) {
      void showAlert({
        title: 'Không có quyền thực hiện',
        message: 'Bạn không có quyền biên tập lịch mùa (seasonal.write).',
        tone: 'warning',
      });
      return;
    }
    if (pendingImportAttemptRef.current || pendingCommittedImportRef.current) {
      void showAlert({
        title: 'Đang chờ xử lý khôi phục nhập tệp',
        message: 'Hoàn tất bước Tiếp tục/Kiểm tra hoặc Tải lại sau khi nhập trước khi nhập tệp khác.',
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
      void showAlert({ title: 'Nhập tệp bị chặn', message: formatSeasonalFileActionBlockMessage(block), tone: 'warning' });
      return;
    }
    fileInputRef.current?.click();
  }, [canWriteSeasonal, isSeasonalFileActionBusyNow, showAlert]);

  const applyCommittedSeasonalDraftImport = useCallback(async (
    response: SeasonalDraftImportResponse,
    seasonId: string,
    seasonCode: string,
    fallbackSourceRowCount: number,
  ) => {
    setUploadProgress(buildImportProgress('Đang nạp lại bản nháp lịch bay', 85, seasonCode));
    const operatorSessionEpoch = getOperatorSessionEpoch();
    const refreshedSeasons = await getSeasons({ operatorSessionEpoch });
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    let targetSeason = refreshedSeasons.find((s) => s.id === seasonId || s.code === seasonCode || s.seasonCode === seasonCode);
    if (!targetSeason) {
      targetSeason = (await findSeasonByCode(seasonCode, { operatorSessionEpoch })) ?? undefined;
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    }
    const resolvedSeasonId = targetSeason?.id || seasonId;

    const draftData = await loadFullSeasonalDraftRecords(resolvedSeasonId, getSeasonalDraftWindowV1);
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    latestDraftRevisionRef.current = draftData.revision;
    latestDraftEpochRef.current = draftData.epoch;
    setHistoryDraftTokens({ revision: draftData.revision, epoch: draftData.epoch });

    const patternRows = buildPatternRowsFromRecords(draftData.records, new Map());
    applySeasonData(patternRows, draftData.records, new Map());
    setCachedSeasonData(resolvedSeasonId, {
      rows: patternRows,
      records: draftData.records,
      modifications: new Map(),
      seasonDataVersion: targetSeason?.dataVersion,
    });
    setCachedSeasons(refreshedSeasons);
    useSeasonWorkspaceStore.getState().setSeasons(refreshedSeasons, operatorSessionEpoch);

    if (targetSeason) {
      setActiveSeason(targetSeason);
      sessionStorage.setItem('activeSeasonId', targetSeason.id);
    }

    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: resolvedSeasonId,
      season: targetSeason ?? activeSeason!,
      rows: patternRows,
      records: draftData.records,
      modifications: new Map(),
      syncMeta: {
        seasonId: resolvedSeasonId,
        localRevision: Number(draftData.revision) || 0,
        pendingCount: 0,
        lastLocalChangeAt: Date.now(),
        baseServerVersion: targetSeason?.dataVersion ?? 0,
        syncStatus: 'synced',
      },
      windowKey: currentSeasonalWindowKey,
    });

    setDraftState(null);
    setSelectedRecordIds(new Set());
    setModHistory([]);
    setModifications(new Map());

    // Clear receipt ONLY AFTER successful authoritative refresh!
    clearSeasonalDraftImportRecoveryReceipt(sessionStorage);
    setPendingImportAttempt(null);
    setPendingCommittedImport(null);
    setImportPreviewState({ kind: 'idle' });

    const sourceRowCount = response.result?.counts?.sourceRowCount ?? fallbackSourceRowCount;
    void showAlert({
      title: 'Nhập kế hoạch thành công',
      message: `Đã nạp thành công ${sourceRowCount} dòng vào bản nháp mùa ${seasonCode}. Dữ liệu đã sẵn sàng để kiểm tra và Công bố (Publish) sang Vận hành.`,
    });
  }, [activeSeason, applySeasonData, currentSeasonalWindowKey, setActiveSeason, setDraftState, setPendingCommittedImport, setPendingImportAttempt, showAlert]);

  const handlePendingCommittedRefresh = useCallback(async () => {
    const committedImport = pendingCommittedImportRef.current;
    if (!committedImport) return;
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Tải lại bị chặn', message: formatSeasonalFileActionBlockMessage(block), tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) return;
    setUploading(true);
    setUploadProgress(buildImportProgress('Đang làm mới dữ liệu đã nhập', 80, committedImport.seasonCode));
    try {
      await applyCommittedSeasonalDraftImport(
        {
          contractVersion: 4,
          batchId: committedImport.batchId,
          requestId: committedImport.requestId,
          seasonId: committedImport.seasonId,
          status: 'committed',
          previewHash: pendingImportAttemptRef.current?.previewHash ?? '',
          result: {
            status: 'committed',
            batchId: committedImport.batchId,
            seasonId: committedImport.seasonId,
            draftEpoch: committedImport.draftEpoch,
            draftRevision: committedImport.draftRevision,
            counts: committedImport.counts,
            serverHighWater: committedImport.serverHighWater,
          },
        },
        committedImport.seasonId,
        committedImport.seasonCode,
        committedImport.counts.sourceRowCount,
      );
    } catch (error) {
      void showAlert({
        title: 'Làm mới dữ liệu thất bại',
        message: `Không thể hoàn tất làm mới bản nháp mùa ${committedImport.seasonCode}: ${getLoadErrorMessage(error)}. Biên nhận vẫn được giữ lại để bạn thử lại.`,
        tone: 'warning',
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    applyCommittedSeasonalDraftImport,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    showAlert,
  ]);

  const handleResumeImportAttempt = useCallback(async () => {
    const receipt = pendingImportAttemptRef.current;
    if (!receipt) return;
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Tiếp tục bị chặn', message: formatSeasonalFileActionBlockMessage(block), tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) return;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setUploading(true);
    setUploadProgress(buildImportProgress('Đang kiểm tra trạng thái nhập tệp', 50, receipt.requestId));
    try {
      const statusInvalidation = validateSeasonalFileAction(operation);
      if (statusInvalidation) {
        showSeasonalFileActionInvalidation('import', statusInvalidation);
        return;
      }
      const status = await getSeasonalDraftImportStatusV1(receipt.requestId, { operatorSessionEpoch });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      if (status.status === 'committed') {
        const committedResult: SeasonalDraftImportCommittedResult = {
          batchId: status.batchId,
          requestId: receipt.requestId,
          seasonId: receipt.seasonId,
          seasonCode: receipt.seasonCode,
          draftRevision: status.result?.draftRevision ? String(status.result.draftRevision) : '0',
          draftEpoch: status.result?.draftEpoch ?? receipt.expectedEpoch ?? '',
          counts: status.result?.counts ?? receipt.counts,
          serverHighWater: status.result?.serverHighWater,
        };
        const committedReceipt = markSeasonalDraftImportRecoveryCommitted(receipt, committedResult);
        persistSeasonalDraftImportRecoveryReceipt(sessionStorage, committedReceipt);
        setPendingImportAttempt(committedReceipt);
        setPendingCommittedImport(committedResult);
        setImportPreviewState({ kind: 'committed-refresh-pending', result: committedResult });
        try {
          await applyCommittedSeasonalDraftImport(status, receipt.seasonId, receipt.seasonCode, receipt.counts.sourceRowCount);
        } catch (refreshErr) {
          void showAlert({
            title: 'Làm mới dữ liệu thất bại',
            message: `Lô nhập đã hoàn tất trên máy chủ, nhưng không thể làm mới dữ liệu: ${getLoadErrorMessage(refreshErr)}. Bấm "Làm mới dữ liệu" để thử lại.`,
            tone: 'warning',
          });
        }
        return;
      }
      if (status.status === 'validated') {
        const preview = draftImportResponseToPreview(status, receipt);
        const nextReceipt = buildSeasonalDraftImportRecoveryReceipt(preview, currentOperatorUserIdRef.current);
        persistSeasonalDraftImportRecoveryReceipt(sessionStorage, nextReceipt);
        setPendingImportAttempt(nextReceipt);
        setImportPreviewState({ kind: 'preview', result: preview, confirmation: '' });
        return;
      }
      await showAlert({
        title: 'Nhập lịch mùa không khả dụng',
        message: `Lô nhập đang ở trạng thái ${formatImportStatusLabel(status.status)}.`,
        tone: 'warning',
      });
      clearSeasonalDraftImportRecoveryReceipt(sessionStorage);
      setPendingImportAttempt(null);
      setImportPreviewState({ kind: 'idle' });
    } catch (error) {
      setPendingImportAttempt(receipt);
      void showAlert({
        title: 'Không thể kiểm tra trạng thái nhập',
        message: `Yêu cầu ${receipt.requestId}: ${getLoadErrorMessage(error)}`,
        tone: 'warning',
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    applyCommittedSeasonalDraftImport,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    setPendingCommittedImport,
    setPendingImportAttempt,
    showAlert,
    showSeasonalFileActionInvalidation,
    validateSeasonalFileAction,
  ]);

  const stagePreparedSeasonalImport = useCallback(async (
    attemptedImport: SeasonalDraftImportStageInput,
    operation: SeasonalFileActionOperation,
    operatorSessionEpoch: number,
  ) => {
    const stageInvalidation = validateSeasonalFileAction(operation);
    if (stageInvalidation) {
      showSeasonalFileActionInvalidation('import', stageInvalidation);
      return;
    }
    setImportPreviewState({ kind: 'staging' });
    setUploadProgress(buildImportProgress(
      'Đang chuẩn bị nhập toàn bộ lịch mùa',
      55,
      `${attemptedImport.sourceRows.length} dòng nguồn`,
    ));
    const stageRes = await stageSeasonalDraftImportV1(attemptedImport);
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    const preview = draftImportResponseToPreview(stageRes, attemptedImport);
    const receipt = buildSeasonalDraftImportRecoveryReceipt(preview, currentOperatorUserIdRef.current);
    persistSeasonalDraftImportRecoveryReceipt(sessionStorage, receipt);
    setPendingImportAttempt(receipt);
    setImportPreviewState({ kind: 'preview', result: preview, confirmation: '' });
  }, [
    setPendingImportAttempt,
    showSeasonalFileActionInvalidation,
    validateSeasonalFileAction,
  ]);

  const handleFile = useCallback(async (file: File) => {
    if (!isSeasonalPlanningV1Enabled()) {
      void showAlert({
        title: 'Nhập tệp không khả dụng',
        message: 'Cần bật không gian Planning để nhập lịch mùa.',
        tone: 'warning',
      });
      return;
    }
    if (!canWriteSeasonal) {
      void showAlert({
        title: 'Không có quyền thực hiện',
        message: 'Bạn không có quyền biên tập lịch mùa (seasonal.write).',
        tone: 'warning',
      });
      return;
    }
    if (pendingImportAttemptRef.current || pendingCommittedImportRef.current) {
      void showAlert({
        title: 'Đang chờ xử lý khôi phục nhập tệp',
        message: 'Hoàn tất bước Tiếp tục/Kiểm tra hoặc Tải lại sau khi nhập trước khi nhập tệp khác.',
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
      void showAlert({ title: 'Nhập tệp bị chặn', message: formatSeasonalFileActionBlockMessage(block), tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) {
      void showAlert({
        title: 'Nhập tệp bị chặn',
        message: 'Một thao tác Lịch mùa khác đang được xử lý.',
        tone: 'warning',
      });
      return;
    }
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setUploading(true);
    let attemptedImport: SeasonalDraftImportStageInput | null = null;
    try {
      setUploadProgress(buildImportProgress('Đang đọc tệp', 5));
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const { seasonCode, rows: parsedRows, issues } = parseSeasonalSchedule(workbook);

      if (issues.length > 0) {
        const visibleIssues = issues.slice(0, 10).map((issue) => issue.message);
        const remainingCount = issues.length - visibleIssues.length;
        const remainingMessage = remainingCount > 0 ? `\n...và ${remainingCount} vấn đề khác.` : '';
        void showAlert({
          title: 'Nhập tệp thất bại',
          message: `${visibleIssues.join('\n')}${remainingMessage}`,
          tone: 'warning',
        });
        return;
      }

      if (parsedRows.length === 0) {
        void showAlert({ title: 'Nhập tệp thất bại', message: 'Tệp không chứa dữ liệu hợp lệ.', tone: 'warning' });
        return;
      }

      setUploadProgress(buildImportProgress('Kiểm tra mùa mục tiêu', 20));
      const existing = await findSeasonByCode(seasonCode, { operatorSessionEpoch });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;

      let expectedEpoch: string | null = null;
      let expectedRevision = '0';

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
            title: 'Nhập tệp bị chặn',
            message: `${dirtyGuard.message}\n\nLưu các thay đổi đang chờ trước khi nhập mùa này.`,
            tone: 'warning',
          });
          return;
        }

        if (activeSeason?.id === existing.id) {
          expectedEpoch = latestDraftEpochRef.current ?? null;
          expectedRevision = String(latestDraftRevisionRef.current ?? '0');
        } else {
          const targetDraftWindow = await getSeasonalDraftWindowV1({ seasonId: existing.id });
          if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
          expectedEpoch = targetDraftWindow.epoch;
          expectedRevision = String(targetDraftWindow.revision);
        }
      } else {
        expectedEpoch = null;
        expectedRevision = '0';
      }

      setUploadProgress(buildImportProgress('Đang chuẩn bị dữ liệu nguồn', 35, `${parsedRows.length} dòng nguồn`));
      attemptedImport = await prepareSeasonalDraftImportStageInput({
        seasonId: existing?.id ?? null,
        seasonCode,
        expectedEpoch,
        expectedRevision,
        fileName: file.name,
        uploadedAt: Date.now(),
        sourceRows: parsedRows,
      });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      await stagePreparedSeasonalImport(attemptedImport, operation, operatorSessionEpoch);
    } catch (err) {
      console.error('Upload error:', err);
      setImportPreviewState({ kind: 'idle' });
      void showAlert({ title: 'Nhập tệp thất bại', message: getLoadErrorMessage(err), tone: 'error' });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    activeSeason,
    beginSeasonalFileAction,
    canWriteSeasonal,
    finishSeasonalFileAction,
    isSeasonalFileActionBusyNow,
    stagePreparedSeasonalImport,
    showAlert,
    syncPendingCount,
  ]);

  const handleCancelImportPreview = useCallback(async () => {
    if (importPreviewState.kind !== 'preview') return;
    const preview = importPreviewState.result;
    setUploading(true);
    try {
      if (preview.status === 'validated') {
        await cancelSeasonalDraftImportV1(preview.batchId);
      }
      clearSeasonalDraftImportRecoveryReceipt(sessionStorage);
      setPendingImportAttempt(null);
      setImportPreviewState({ kind: 'idle' });
    } catch (error) {
      void showAlert({
        title: 'Hủy nhập tệp thất bại',
        message: getLoadErrorMessage(error),
        tone: 'warning',
      });
    } finally {
      setUploading(false);
    }
  }, [importPreviewState, setPendingImportAttempt, showAlert]);

  const handleCommitImportPreview = useCallback(async () => {
    if (importPreviewState.kind !== 'preview') return;
    if (!canCommitSeasonalImportPreview({
      state: importPreviewState,
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    })) {
      return;
    }
    const preview = importPreviewState.result;
    const receipt = pendingImportAttemptRef.current;
    if (!receipt) return;
    const block = getSeasonalFileActionBlock({
      action: 'import',
      hasDraftChanges: latestDraftStateRef.current.hasDraftChanges,
      busy: isSeasonalFileActionBusyNow(),
    });
    if (block) {
      void showAlert({ title: 'Nhập tệp bị chặn', message: formatSeasonalFileActionBlockMessage(block), tone: 'warning' });
      return;
    }
    const operation = beginSeasonalFileAction('import');
    if (!operation) return;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setUploading(true);
    setImportPreviewState({ kind: 'committing', result: preview });
    setUploadProgress(buildImportProgress('Đang áp dụng toàn bộ lịch mùa vào bản nháp', 75, preview.seasonCode));
    let committed = false;
    let committedResult: SeasonalDraftImportCommittedResult | null = null;
    try {
      const commitRes = await commitSeasonalDraftImportV1({
        batchId: preview.batchId,
        previewHash: preview.previewHash,
      });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;

      committedResult = {
        batchId: preview.batchId,
        requestId: receipt.requestId,
        seasonId: preview.seasonId,
        seasonCode: preview.seasonCode,
        draftRevision: commitRes.result?.draftRevision ? String(commitRes.result.draftRevision) : String(preview.expectedRevision ?? '0'),
        draftEpoch: commitRes.result?.draftEpoch ?? preview.expectedEpoch ?? '',
        counts: commitRes.result?.counts ?? preview.counts,
        serverHighWater: commitRes.result?.serverHighWater,
      };
      const committedReceipt = markSeasonalDraftImportRecoveryCommitted(receipt, committedResult);
      setPendingImportAttempt(committedReceipt);
      setPendingCommittedImport(committedResult);
      setImportPreviewState({ kind: 'committed-refresh-pending', result: committedResult });
      committed = true;
      persistSeasonalDraftImportRecoveryReceipt(sessionStorage, committedReceipt);

      await applyCommittedSeasonalDraftImport(commitRes, preview.seasonId, preview.seasonCode, preview.counts.sourceRowCount);
    } catch (error) {
      const message = getLoadErrorMessage(error);
      if (committed && committedResult) {
        void showAlert({
          title: 'Làm mới dữ liệu thất bại',
          message: `Lô nhập đã ghi nhận thành công vào bản nháp mùa ${preview.seasonCode}, nhưng không thể làm mới dữ liệu giao diện: ${message}. Vui lòng bấm "Làm mới dữ liệu" để thử lại.`,
          tone: 'warning',
        });
      } else if (/stale|changed|expired/i.test(message)) {
        clearSeasonalDraftImportRecoveryReceipt(sessionStorage);
        setPendingImportAttempt(null);
        setImportPreviewState({ kind: 'idle' });
        void showAlert({
          title: 'Bản nháp đã thay đổi',
          message: 'Bản nháp mùa đã thay đổi hoặc phiên bản hết hạn. Vui lòng thử nạp lại file.',
          tone: 'warning',
        });
      } else {
        setPendingImportAttempt(receipt);
        setImportPreviewState({ kind: 'preview', result: preview, confirmation: '' });
        void showAlert({
          title: 'Lỗi nạp bản nháp',
          message: message || 'Lỗi không xác định khi commit bản nháp mùa.',
          tone: 'warning',
        });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      finishSeasonalFileAction(operation);
    }
  }, [
    applyCommittedSeasonalDraftImport,
    beginSeasonalFileAction,
    finishSeasonalFileAction,
    importPreviewState,
    isSeasonalFileActionBusyNow,
    setPendingCommittedImport,
    setPendingImportAttempt,
    showAlert,
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
          title="Lịch mùa"
          subtitle={activeSeason ? buildSeasonDisplayLabel(activeSeason) : 'Quản lý và rà soát lịch bay tổng thể cho mùa sắp tới.'}
          seasonControl={seasons.length > 0 && (
            <div className="relative group">
              <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                <span className="material-symbols-outlined text-[18px] text-primary">calendar_today</span>
              </div>
              <select
                value={activeSeason?.id ?? ''}
                onChange={(event) => handleSeasonChange(event.target.value)}
                disabled={seasonalFileActionActive || (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges))}
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
                {draftSaveState.status === 'stale' && (
                  <span className="flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950">
                    <span className="material-symbols-outlined text-[16px]">warning</span>
                    <span>Xung đột phiên bản</span>
                    <button
                      type="button"
                      onClick={() => { void handleRetryLoad(); }}
                      className="ml-1 rounded bg-amber-800 px-2 py-0.5 text-xs text-white hover:bg-amber-700 font-medium"
                    >
                      Tải lại
                    </button>
                  </span>
                )}
                <FetchServerUpdatesButton
                  fetching={fetchingServerData}
                  progress={fetchProgress}
                  disabled={syncInProgress || seasonalFileActionActive || draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges}
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
            )
          )}
          draftControls={!isSeasonalPlanningV1Enabled() && hasDraftChanges && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900">
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              <span className="text-xs font-semibold">
                {draftChangeCount} thay đổi nháp
              </span>
              <button
                onClick={handleDiscardSeasonalDraft}
                disabled={syncInProgress || seasonalFileActionActive}
                className="rounded px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Hủy bỏ
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
                title="Tạo mới chuyến bay mùa"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                Thêm chuyến bay
              </button>
              <div className="relative">
                <button
                  className="flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-1.5 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={syncInProgress || hasDraftChanges || modHistory.length === 0 || isUndoing || seasonalFileActionActive}
                  onClick={() => setIsUndoOpen(!isUndoOpen)}
                  title="Hoàn tác thay đổi cục bộ"
                >
                  <span className={`material-symbols-outlined text-[16px] ${isUndoing ? 'animate-spin' : ''}`}>{isUndoing ? 'sync' : 'undo'}</span>
                  Hoàn tác{modHistory.length > 0 ? ` (${modHistory.length})` : ''}
                </button>
                {isUndoOpen && modHistory.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setIsUndoOpen(false)} />
                    <div className="absolute left-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg sm:left-auto sm:right-0">
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
                              disabled={isUndoing || seasonalFileActionActive}
                              className="flex-shrink-0 rounded-lg bg-error-container px-3 py-1.5 text-xs font-medium text-on-error-container transition-colors hover:bg-error/20 disabled:opacity-50"
                            >
                              {idx === 0 ? 'Hoàn tác' : 'Khôi phục'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {isSeasonalPlanningV1Enabled() && (
                <button
                  className="flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 font-label-caps text-label-caps text-white shadow-sm transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => { void handleOpenPublishModal(); }}
                  disabled={syncInProgress || seasonalFileActionActive || (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges))}
                  title="Công bố lịch bay mùa sang phân hệ Vận hành (Operations)"
                >
                  <span className="material-symbols-outlined text-[16px]">publish</span>
                  Công bố lịch bay
                </button>
              )}
              {isSeasonalPlanningV1Enabled() && (
                <button
                  className="flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-label-caps text-label-caps text-on-surface shadow-sm transition-colors hover:bg-surface-variant/30 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => {
                    setHistoryDraftTokens({
                      revision: latestDraftRevisionRef.current,
                      epoch: latestDraftEpochRef.current,
                    });
                    setIsHistoryModalOpen(true);
                  }}
                  title="Xem lịch sử các phiên bản đã công bố, so sánh và khôi phục"
                >
                  <span className="material-symbols-outlined text-[16px]">history</span>
                  Lịch sử phiên bản
                </button>
              )}
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
          {legacyPendingReceiptFound && !uploading && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Phát hiện biên nhận nhập từ phiên bản cũ không tương thích</div>
                <div className="mt-1 text-xs text-amber-900">
                  Hệ thống tìm thấy biên nhận nhập cũ (V3). Biên nhận này không thuộc luồng Kế hoạch (Planning) mới và không thể tự động khôi phục. Vui lòng bấm &ldquo;Xóa biên nhận cũ&rdquo; và thực hiện nạp tệp trực tiếp vào Planning.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearLegacySeasonalImportReceipts(sessionStorage);
                  setLegacyPendingReceiptFound(false);
                }}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-amber-900 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                Xóa biên nhận cũ
              </button>
            </div>
          )}
          {pendingImportAttempt && !uploading && importPreviewState.kind === 'idle' && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Chưa hoàn tất nhập bản nháp lịch mùa</div>
                <div className="mt-1 break-all text-xs text-amber-900">
                  Yêu cầu {pendingImportAttempt.requestId} (mùa {pendingImportAttempt.seasonCode} · {pendingImportAttempt.counts.sourceRowCount} dòng nguồn) cần kiểm tra trực tiếp từ máy chủ.
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void handleResumeImportAttempt(); }}
                disabled={seasonalFileActionBusy || hasDraftChanges}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-amber-900 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                Tiếp tục/Kiểm tra ({pendingImportAttempt.counts.sourceRowCount} dòng)
              </button>
            </div>
          )}
          {pendingCommittedImport && !uploading && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-sky-300 bg-sky-50 p-4 text-sky-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Đã nhập bản nháp, đang chờ làm mới</div>
                <div className="mt-1 text-xs text-sky-900">
                  Mùa {pendingCommittedImport.seasonCode} ({pendingCommittedImport.counts.sourceRowCount} dòng nguồn) đã được ghi nhận trong lô {pendingCommittedImport.batchId}.
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void handlePendingCommittedRefresh(); }}
                disabled={seasonalFileActionBusy || hasDraftChanges}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-sky-800 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                Làm mới dữ liệu ({pendingCommittedImport.counts.sourceRowCount} dòng)
              </button>
            </div>
          )}
          {uploading && (
            <div className="mb-4 p-4 bg-primary-fixed rounded-lg border border-primary/20">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined animate-spin text-primary">sync</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-primary truncate">{uploadProgress?.label ?? 'Đang nhập tệp'}</span>
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter mb-md" aria-label="Tóm tắt chỉ số lịch mùa">
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Tổng số chuyến bay</span>
              <div className="flex items-baseline gap-2">
                <span className="font-h2 text-h2 text-on-surface">{flightStats.total.toLocaleString()}</span>
                <span className="text-sm text-on-surface-variant">
                  (Đến: {flightStats.arr.toLocaleString()} / Đi: {flightStats.dep.toLocaleString()})
                </span>
              </div>
            </div>
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Đường bay đang bay</span>
              <span className="font-h2 text-h2 text-on-surface">{flightStats.uniqueRoutes.toLocaleString()}</span>
            </div>
            <div className="bg-surface-container-lowest p-md rounded-xl border border-surface-variant shadow-sm flex flex-col justify-center">
              <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Hiệu lực mùa</span>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-outline text-[18px]">date_range</span>
                <span className="font-body-sm text-body-sm text-on-surface">
                  {activeSeason ? `${formatDate(activeSeason.effectiveStart)} - ${formatDate(activeSeason.effectiveEnd)}` : '-'}
                </span>
              </div>
            </div>
          </div>

          <div className="mb-lg flex flex-col gap-3 rounded-xl border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm md:flex-row md:items-center md:justify-between" aria-label="Thanh công cụ bảng lịch mùa">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="flex items-center gap-1.5 bg-primary text-on-primary text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleImportClick}
                disabled={seasonalFileActionBusy || hasDraftChanges || seasonalImportRecoveryPending || !canWriteSeasonal || (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges))}
                title={!canWriteSeasonal ? 'Bạn không có quyền biên tập lịch mùa (seasonal.write)' : 'Nhập toàn bộ lịch mùa vào bản nháp'}
              >
                <span className="material-symbols-outlined text-[16px]">cloud_upload</span>
                Nhập tệp
              </button>
              <button
                className="flex items-center gap-1.5 border border-outline-variant text-on-surface text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-surface-container-low transition-colors"
                onClick={() => setFilters({flight: '', type: '', route: '', aircraft: '', time: '', dateFrom: '', dateTo: ''})}
              >
                <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
                Xóa bộ lọc
              </button>
              <button
                className="flex items-center gap-1.5 bg-tertiary-container text-on-tertiary-container text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-tertiary-container/80 transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleExportUpdated}
                disabled={(!exportAllSelected && (activeDisplayLegs.length === 0 || selectedRecordIds.size === 0)) || seasonalFileActionBusy || hasDraftChanges || (isSeasonalPlanningV1Enabled() && (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges))}
                title={isExporting ? 'Đang xuất các chuyến bay đã chọn' : exportAllSelected ? 'Xuất toàn bộ chuyến bay trong mùa' : selectedRecordIds.size === 0 ? 'Chọn chuyến bay để xuất' : 'Xuất các chuyến bay đã chọn'}
              >
                <span className={`material-symbols-outlined text-[16px] ${isExporting ? 'animate-spin' : ''}`}>{isExporting ? 'sync' : 'download'}</span>
                {isExporting ? 'Đang xuất...' : exportAllSelected ? 'Xuất tất cả' : selectedRecordIds.size > 0 ? `Xuất (${selectedRecordIds.size})` : 'Xuất'}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-on-surface-variant">
              <span>{filteredGroups.length.toLocaleString()} nhóm sau khi lọc</span>
              <span>{exportAllSelected ? 'Đã chọn toàn bộ chuyến bay trong mùa' : `Đã chọn ${selectedRecordIds.size.toLocaleString()} để xuất`}</span>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-surface-variant shadow-sm overflow-hidden flex flex-col">
            {loading ? (
              <LoadingStatusPanel progress={loadProgress} className="min-h-[320px]" />
            ) : loadError ? (
              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="font-title-sm text-title-sm text-error">Không thể tải dữ liệu lịch bay</div>
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
                      Thử lại
                    </button>
                  </div>
                )}
              </div>
            ) : activeDisplayLegs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-on-surface-variant">
                <div>{hasActiveFilters ? 'Không có chuyến bay nào khớp với bộ lọc hiện tại.' : 'Chưa có dữ liệu. Vui lòng nhập tệp lịch bay mùa.'}</div>
                {hasActiveFilters ? (
                  <button
                    type="button"
                    className="flex items-center gap-2 border border-outline-variant text-on-surface font-label-caps text-label-caps px-4 py-2 rounded-lg hover:bg-surface-container-low transition-colors"
                    onClick={() => setFilters({flight: '', type: '', route: '', aircraft: '', time: '', dateFrom: '', dateTo: ''})}
                  >
                    <span className="material-symbols-outlined text-[18px]">filter_alt_off</span>
                    Xóa bộ lọc
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
                              aria-label="Chọn toàn bộ chuyến bay trong mùa để xuất"
                              className="h-4 w-4 rounded border-outline text-primary focus:ring-primary disabled:opacity-40"
                            />
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Xuất</span>
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Số hiệu</span>
                            <input 
                              placeholder="Lọc..." 
                              value={filters.flight}
                              onChange={e => setFilters({...filters, flight: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[10%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Loại</span>
                            <input 
                              placeholder="Đến/Đi..." 
                              value={filters.type}
                              onChange={e => setFilters({...filters, type: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Đường bay</span>
                            <input 
                              placeholder="Lọc..." 
                              value={filters.route}
                              onChange={e => setFilters({...filters, route: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[10%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Loại tàu bay</span>
                            <input 
                              placeholder="Lọc..." 
                              value={filters.aircraft}
                              onChange={e => setFilters({...filters, aircraft: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Giờ (STA/STD)</span>
                            <input 
                              placeholder="Lọc..." 
                              value={filters.time}
                              onChange={e => setFilters({...filters, time: e.target.value})}
                              className="w-full bg-surface-container-highest border border-surface-variant rounded px-2 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                            />
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[15%]">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Ngày bay</span>
                            <div className="h-[26px]"></div> {/* spacer to align with inputs */}
                          </div>
                        </th>
                        <th className="py-3 px-4 align-top w-[20%]">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Thời hạn hiệu lực</span>
                            <div className="flex items-center gap-1">
                              <input 
                                type="date"
                                value={filters.dateFrom}
                                onChange={e => setFilters({...filters, dateFrom: e.target.value})}
                                className="w-full bg-surface-container-highest border border-surface-variant rounded px-1 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                                title="Ngày bắt đầu"
                              />
                              <span className="text-outline-variant text-xs">-</span>
                              <input 
                                type="date"
                                value={filters.dateTo}
                                onChange={e => setFilters({...filters, dateTo: e.target.value})}
                                className="w-full bg-surface-container-highest border border-surface-variant rounded px-1 py-1 text-xs font-normal focus:outline-none focus:border-primary" 
                                title="Ngày kết thúc"
                              />
                            </div>
                          </div>
                        </th>
                        <th className="py-3 px-2 align-top w-[8%]" aria-label="Cột thao tác">
                          <div className="flex flex-col gap-2 h-full justify-between">
                            <span className="font-label-caps text-label-caps text-on-surface-variant whitespace-nowrap">Thao tác</span>
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
                                aria-label={`Chọn ${combinedFlight ?? 'chuyến bay'} để xuất`}
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
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-primary-container text-on-primary-container">ĐẾN</span>
                                )}
                                {hasDep && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-secondary-container text-on-secondary-container">ĐI</span>
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
                                    title="Hiện các chặng bay phù hợp để liên kết"
                                    disabled={seasonalFileActionActive}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!fileActionControllerRef.current.isFileActionActive()) setLinkModalGroupKey(group.key);
                                    }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link</span>
                                    Liên kết
                                  </button>
                                )}
                                {linkAction.canUnlink && (
                                  <button
                                    className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold text-tertiary hover:bg-tertiary-container/40 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                    title="Hủy liên kết toàn bộ dòng Lịch mùa này"
                                    disabled={seasonalFileActionActive}
                                    onClick={(e) => { e.stopPropagation(); handleUnlinkGroup(group); }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link_off</span>
                                    Hủy liên kết
                                  </button>
                                )}
                                <button
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-outline hover:bg-error-container hover:text-error transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                  title="Xóa nhóm chuyến bay"
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
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Hiển thị {page * PAGE_SIZE + 1} đến {Math.min((page + 1) * PAGE_SIZE, filteredGroups.length)} trong tổng số {filteredGroups.length.toLocaleString()} nhóm</span>
                  <div className="flex items-center gap-2">
                    <span className="font-body-sm text-body-sm text-on-surface-variant">Trang {page + 1} / {totalPages}</span>
                    <div className="flex gap-1">
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-outline disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page === 0}
                        onClick={() => setPage(0)}
                        title="Trang đầu"
                      >
                        <span className="material-symbols-outlined text-[20px]">first_page</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-outline disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page === 0}
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        title="Trang trước"
                      >
                        <span className="material-symbols-outlined text-[20px]">chevron_left</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        title="Trang sau"
                      >
                        <span className="material-symbols-outlined text-[20px]">chevron_right</span>
                      </button>
                      <button
                        className="p-1 rounded hover:bg-surface-variant text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage(totalPages - 1)}
                        title="Trang cuối"
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
                <h2 className="font-h3 text-h3 text-on-surface">Chặng bay phù hợp</h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {linkModalGroup.airline}{linkModalGroup.arrFlightNumber ?? linkModalGroup.depFlightNumber}
                </p>
              </div>
              <button
                className="p-1 rounded hover:bg-surface-variant text-outline hover:text-on-surface transition-colors"
                onClick={() => setLinkModalGroupKey(null)}
                aria-label="Đóng danh sách liên kết"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              {seasonalLinkCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-4 py-8 text-center text-on-surface-variant">
                  Không tìm thấy chặng bay đối ứng chưa liên kết phù hợp.
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
                            {candidate.linkType === 'overnight' ? 'Qua đêm' : 'Trong ngày'}
                          </span>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {candidate.matchCount} lượt bay
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
                        {linkingCandidateKey === candidate.key ? 'Đang liên kết' : `Liên kết ${candidate.matchCount}`}
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
            // Operator-created rows are manual legs, not imports: mark them
            // client-added so the send boundary persists canonical 'manual'.
            const candidateRecords = flattenRowsToFlightRecords([savedRow]).map((record) => ({
              ...record,
              sourceKind: 'added' as const,
            }));
            // Only the added identity is validated: seasons can still carry
            // pre-policy duplicate flight-days (e.g. legacy NX985 on 2026-07-16)
            // that must not block creating an unrelated flight.
            assertNoDuplicateFlightNumbersForEffectiveRecords(flightRecords, modifications, candidateRecords);
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
            if (isSeasonalPlanningV1Enabled()) {
              const historyTimestamp = Date.now();
              const historyEntry: ModHistoryEntry = {
                id: `LOCAL_ADD_${historyTimestamp}`,
                timestamp: historyTimestamp,
                description: `Đã thêm chuyến bay ${candidateRecords[0]?.airline ?? savedRow.airline}${candidateRecords[0]?.flightNumber ?? (savedRow.arrFlight || savedRow.depFlight || '')}`,
                changes: [],
                recordChanges: candidateRecords.map((record) => ({
                  recordId: record.id,
                  previousRecord: null,
                  newRecord: record,
                })),
              };
              setFlightRecords(nextRecords);
              setDisplayRows(enrichRows(nextRows));
              setDraftSaveState((prev) => ({ ...prev, status: 'saving', hasUnconfirmedChanges: true, error: null }));
              const saveResult = await executeSeasonalPlanningDraftSave({
                seasonId: activeSeason.id,
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
                setModHistory((prev) => trimUiUndoEntries(filterUiUndoEntriesForSession([{ ...historyEntry, draftUndoChanges }, ...prev])));
              }
            } else {
              setDraftState({
                ...baseDraft,
                records: [...baseDraft.records, ...candidateRecords],
              });
            }
            setIsNewFlightOpen(false);
          } catch (err) {
            console.error(err);
            void showAlert({ title: 'Thêm chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
          } finally {
            finishSeasonalMutation(mutation);
          }
        }}
      />

      <SeasonalImportPreviewDialog
        state={
          importPreviewState.kind === 'preview' || importPreviewState.kind === 'committing'
            ? importPreviewState
            : null
        }
        hasDraftChanges={hasDraftChanges}
        busy={uploading || seasonalFileActionActive || seasonalMutationActive}
        onConfirmationChange={(confirmation) => {
          setImportPreviewState((current) => current.kind === 'preview'
            ? { ...current, confirmation }
            : current);
        }}
        onCancel={() => { void handleCancelImportPreview(); }}
        onCommit={() => { void handleCommitImportPreview(); }}
      />
      {activeSeason && isSeasonalPlanningV1Enabled() && (
        <SeasonalPublishModal
          isOpen={isPublishModalOpen}
          seasonId={activeSeason.id}
          seasonCode={activeSeason.seasonCode || activeSeason.code || ''}
          onClose={() => setIsPublishModalOpen(false)}
        />
      )}
      {activeSeason && isSeasonalPlanningV1Enabled() && (
        <SeasonalVersionHistoryModal
          isOpen={isHistoryModalOpen}
          seasonId={activeSeason.id}
          seasonCode={activeSeason.seasonCode || activeSeason.code || ''}
          onClose={() => setIsHistoryModalOpen(false)}
          isRestricted={
            syncInProgress ||
            (seasonalFileActionActive && (!restoreFileActionToken || activeFileActionToken !== restoreFileActionToken)) ||
            (draftSaveState.status === 'saving' || draftSaveState.hasUnconfirmedChanges) ||
            modifications.size > 0
          }
          restrictedReason={
            syncInProgress
              ? 'Đang đồng bộ dữ liệu'
              : seasonalFileActionActive && (!restoreFileActionToken || activeFileActionToken !== restoreFileActionToken)
              ? 'Đang xử lý tệp lịch bay'
              : draftSaveState.status === 'saving'
              ? 'Đang lưu bản nháp'
              : draftSaveState.hasUnconfirmedChanges || modifications.size > 0
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
  );
}
