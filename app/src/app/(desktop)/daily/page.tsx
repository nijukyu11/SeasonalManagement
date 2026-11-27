'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import {
  cancelDailyScheduleImportV2,
  commitDailyScheduleImportV2,
  getDailyScheduleImportV2Status,
  stageDailyScheduleImportV2,
  getOperationalSettings,
  getSeasons,
  loadSeasonWorkspaceWindow,
} from '@/lib/remoteStore';
import {
  buildOperationalDateRange,
  buildOperationalLegPatchAndPreimage,
  flightCounterToDbCounters,
  flightWindowsToDbWindows,
  getOperationalDayVietnamIso,
  isOperationalScheduleV1Enabled,
  shiftVietnamIsoDate,
  subscribeToOperationalChanges,
  type DailyImportLegInputV2,
  type DailyImportStagePayloadV2,
  type DailyImportStageResultV2,
  type OperationalWindowSnapshot,
} from '@/lib/operationalScheduleContract';
import DailyImportPreviewDialogV2 from '@/app/(desktop)/components/DailyImportPreviewDialogV2';
import { useOperationalScheduleStore, isRecentOperationalMutationRequestId } from '@/lib/operationalScheduleAdapter';
import type { OperationalLegChangeInput } from '@/lib/operationalScheduleContract';
import { getSupabaseClient } from '@/lib/supabase';
import { revalidateSeasonWorkspaceWindow } from '@/lib/seasonWorkspaceWindowCoordinator';
import {
  assertNoDuplicateFlightNumbersForEffectiveRecords,
  linkFlightRecordPairs,
  unlinkFlightRecords,
} from '@/lib/atomicSchedule';
import {
  applyModificationBatch,
  buildCanonicalAddedFlightRecords,
  buildFlightRecordHistoryEntry,
} from '@/lib/detailedScheduleState';
import type { NewFlightDateSelection } from '@/lib/detailedScheduleState';
import {
  addDaysToLocalDateTime,
  buildDailyCellModification,
  buildDailyScheduleRows,
  buildDailySummary,
  buildDefaultDailyDateRange,
  filterDailyRows,
  formatDailyScheduleDateTime,
  readDailyDateRangeQuery,
  getDailyRowRecordIds,
  sortDailyRows,
  validateDailyCellEdit,
  type DailyCellField,
  type DailyFilterState,
  type DailyGridField,
  type DailyScheduleRow,
  type DailySortState,
} from '@/lib/dailySchedule';
import {
  uploadDailyImportInChunksV2,
  parseDailyWorkbookWithWorker,
  saveDailyUploadJournal,
  getActiveDailyUploadJournal,
  getDailyUploadJournalByFingerprint,
  clearDailyUploadJournal,
  resolveOperatorId,
  type DailyImportUploadProgress,
} from '@/lib/dailyImportChunkedUpload';
import type { DailyImportCommittedResultV2 } from '@/lib/operationalScheduleContract';
import { normalizeCheckInCounterList } from '@/lib/checkinAllocation';
import { buildDailyScheduleExportFileName, buildDailyScheduleSummaryWorkbook } from '@/lib/dailyScheduleExport';
import { saveWorkbookAsXlsx } from '@/lib/exportSave';
import { buildDailyStandGateModifications } from '@/lib/gateAllocation';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  getCachedSeasons,
  patchCachedSeasonData,
  publishSeasonWorkspaceChanged,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { runNativeScheduleMutation } from '@/lib/nativeSeasonRepository';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';
import type { FlightCounter, FlightModification, FlightRecord, ModHistoryEntry, OperationalSettings, Season } from '@/lib/types';
import NewFlightModal from '../components/NewFlightModal';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteSearchParams } from '../components/RouteCacheContext';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import PbbIcon from '../components/PbbIcon';
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
import { formatUiError } from '@/lib/uiDisplayText';


const GRID_COLUMNS: Array<{ field: DailyGridField; label: string; numeric?: boolean; className?: string }> = [
  { field: 'aircraft', label: 'Loại tàu', className: 'min-w-[92px]' },
  { field: 'arrFlight', label: 'Chuyến đến', className: 'min-w-[112px]' },
  { field: 'sta', label: 'STA', className: 'min-w-[82px]' },
  { field: 'mcat', label: 'MCAT', className: 'min-w-[82px]' },
  { field: 'from', label: 'Nơi đi', className: 'min-w-[90px]' },
  { field: 'arrPax', label: 'Khách đến', numeric: true, className: 'min-w-[88px]' },
  { field: 'carousel', label: 'Băng chuyền', numeric: true, className: 'min-w-[96px]' },
  { field: 'arrStand', label: 'Vị trí đỗ đến', className: 'min-w-[92px]' },
  { field: 'arrCodeShare', label: 'Liên danh đến', className: 'min-w-[132px]' },
  { field: 'depFlight', label: 'Chuyến đi', className: 'min-w-[112px]' },
  { field: 'std', label: 'STD', className: 'min-w-[82px]' },
  { field: 'mcdt', label: 'MCDT', className: 'min-w-[82px]' },
  { field: 'to', label: 'Nơi đến', className: 'min-w-[90px]' },
  { field: 'depPax', label: 'Khách đi', numeric: true, className: 'min-w-[88px]' },
  { field: 'gate', label: 'Cửa', numeric: true, className: 'min-w-[78px]' },
  { field: 'counters', label: 'Quầy', className: 'min-w-[116px]' },
];

const NUMERIC_FILTER_FIELDS = new Set<DailyGridField>(['arrPax', 'carousel', 'depPax', 'gate']);

function todayIso(): string {
  if (isOperationalScheduleV1Enabled()) {
    return getOperationalDayVietnamIso();
  }
  return new Date().toISOString().slice(0, 10);
}

function buildDailyWindowKey(fromDateTime: string, toDateTime: string): string {
  return `daily:${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}`;
}

interface DailyRouteState {
  seasons: Season[];
  season: Season;
  flightRecords: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings | null;
  syncSummary: { pendingCount: number; lastLocalChangeAt: number | null };
  windowKey: string;
}

function readInitialDailyRouteState(input: {
  targetSeasonId: string | null;
  fromDateTime: string;
  toDateTime: string;
}): DailyRouteState | null {
  if (isOperationalScheduleV1Enabled()) return null;
  const storeState = useSeasonWorkspaceStore.getState();
  const cachedSeasons = getCachedSeasons() ?? storeState.seasons;
  if (!cachedSeasons || cachedSeasons.length === 0) return null;

  const targetSeason = (input.targetSeasonId ? cachedSeasons.find((item) => item.id === input.targetSeasonId) : null) ?? cachedSeasons[0];
  if (input.targetSeasonId && input.targetSeasonId !== targetSeason.id) return null;

  const windowKey = buildDailyWindowKey(input.fromDateTime, input.toDateTime);
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

function getAffectedIdsFromDailyModifications(mods: FlightModification[]): string[] {
  return Array.from(new Set(mods.map((mod) => mod.legId)));
}

function normalizeDailyDateParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

function emptyFilterDrafts(): Record<DailyGridField, string> {
  return GRID_COLUMNS.reduce((acc, column) => {
    acc[column.field] = '';
    return acc;
  }, {} as Record<DailyGridField, string>);
}

function counterText(counter: FlightCounter): string {
  if (counter == null) return '';
  if (typeof counter === 'string') return counter;
  return JSON.stringify(counter);
}

function displayValue(value: string | number | null | undefined): string {
  if (value == null || value === '') return '-';
  return String(value);
}

function rowValue(row: DailyScheduleRow, field: DailyGridField): string {
  if (field === 'aircraft') return displayValue(row.arr?.aircraft ?? row.dep?.aircraft);
  if (field === 'arrFlight') return displayValue(row.arr?.flightNumber);
  if (field === 'sta') return displayValue(formatDailyScheduleDateTime(row.arr));
  if (field === 'mcat') return displayValue(row.arr?.mct);
  if (field === 'from') return displayValue(row.arr?.route);
  if (field === 'arrPax') return displayValue(row.arr?.pax);
  if (field === 'carousel') return displayValue(row.arr?.carousel);
  if (field === 'arrStand') return displayValue(row.arr?.stand);
  if (field === 'arrCodeShare') return displayValue(row.arr?.codeShares);
  if (field === 'depFlight') return displayValue(row.dep?.flightNumber);
  if (field === 'std') return displayValue(formatDailyScheduleDateTime(row.dep));
  if (field === 'mcdt') return displayValue(row.dep?.mct);
  if (field === 'to') return displayValue(row.dep?.route);
  if (field === 'depPax') return displayValue(row.dep?.pax);
  if (field === 'gate') return displayValue(row.dep?.gate);
  return displayValue(counterText(row.dep?.counter ?? null));
}

function editableCellValue(row: DailyScheduleRow, field: DailyGridField): string {
  if (field === 'aircraft') return String(row.arr?.aircraft ?? row.dep?.aircraft ?? '');
  if (field === 'sta') return String(row.arr?.schedule ?? '');
  if (field === 'mcat') return String(row.arr?.mct ?? '');
  if (field === 'from') return String(row.arr?.route ?? '');
  if (field === 'arrPax') return row.arr?.pax == null ? '' : String(row.arr.pax);
  if (field === 'carousel') return row.arr?.carousel == null ? '' : String(row.arr.carousel);
  if (field === 'arrStand') return row.arr?.stand == null ? '' : String(row.arr.stand);
  if (field === 'arrCodeShare') return String(row.arr?.codeShares ?? '');
  if (field === 'std') return String(row.dep?.schedule ?? '');
  if (field === 'mcdt') return String(row.dep?.mct ?? '');
  if (field === 'to') return String(row.dep?.route ?? '');
  if (field === 'depPax') return row.dep?.pax == null ? '' : String(row.dep.pax);
  if (field === 'gate') return row.dep?.gate == null ? '' : String(row.dep.gate);
  if (field === 'counters') return counterText(row.dep?.counter ?? null);
  return rowValue(row, field);
}

function editableCellTarget(
  row: DailyScheduleRow,
  field: DailyGridField
): { recordId: string; field: DailyCellField } | null {
  if (field === 'aircraft') {
    const record = row.arr ?? row.dep;
    return record ? { recordId: record.id, field: 'aircraft' } : null;
  }
  if (field === 'sta' && row.arr) return { recordId: row.arr.id, field: 'sta' };
  if (field === 'mcat' && row.arr) return { recordId: row.arr.id, field: 'mcat' };
  if (field === 'from' && row.arr) return { recordId: row.arr.id, field: 'from' };
  if (field === 'arrPax' && row.arr) return { recordId: row.arr.id, field: 'arrPax' };
  if (field === 'carousel' && row.arr) return { recordId: row.arr.id, field: 'carousel' };
  if (field === 'arrStand' && row.arr) return { recordId: row.arr.id, field: 'arrStand' };
  if (field === 'arrCodeShare' && row.arr) return { recordId: row.arr.id, field: 'arrCodeShare' };
  if (field === 'std' && row.dep) return { recordId: row.dep.id, field: 'std' };
  if (field === 'mcdt' && row.dep) return { recordId: row.dep.id, field: 'mcdt' };
  if (field === 'to' && row.dep) return { recordId: row.dep.id, field: 'to' };
  if (field === 'depPax' && row.dep) return { recordId: row.dep.id, field: 'depPax' };
  if (field === 'gate' && row.dep) return { recordId: row.dep.id, field: 'gate' };
  if (field === 'counters' && row.dep) return { recordId: row.dep.id, field: 'counters' };
  return null;
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function inferDailyLinkType(arrivals: FlightRecord[], departures: FlightRecord[]): 'overnight' | 'sameday' {
  const firstArr = [...arrivals].sort((a, b) => a.date.localeCompare(b.date) || a.schedule.localeCompare(b.schedule))[0];
  const firstDep = [...departures].sort((a, b) => a.date.localeCompare(b.date) || a.schedule.localeCompare(b.schedule))[0];
  return firstArr && firstDep && firstDep.schedule < firstArr.schedule ? 'overnight' : 'sameday';
}

function rowActionLabel(row: DailyScheduleRow, isSelected: boolean): string {
  if (isSelected) return 'Đã chọn';
  if (row.arr && row.dep) return row.arr.linkedRecordId === row.dep.id ? 'Đã ghép' : 'Cặp chuyến';
  return row.arr ? 'Đến' : 'Đi';
}

function hasDailyLinkInfo(row: DailyScheduleRow): boolean {
  return Boolean(
    row.arr?.linkedRecordId ||
    row.arr?.linkType ||
    row.dep?.linkedRecordId ||
    row.dep?.linkType ||
    (row.arr != null && row.dep != null && !row.pairKey.startsWith('single:'))
  );
}

function EditableCell({
  value,
  displayText,
  numeric,
  onCommit,
}: {
  value: string;
  displayText?: string;
  numeric?: boolean;
  onCommit: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const skipNextCommitRef = useRef(false);

  const commit = async () => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    if (committing) return;
    if (draft === value) {
      setEditing(false);
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      await onCommit(draft);
      setEditing(false);
    } catch (err) {
      setError(formatUiError(err, 'Lỗi chỉnh sửa ô'));
      setEditing(true);
    } finally {
      setCommitting(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={committing}
        className={`w-full min-w-0 rounded border bg-transparent px-1.5 py-1 text-left text-xs text-on-surface outline-none transition-colors hover:border-outline-variant focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary disabled:opacity-60 ${
          error ? 'border-error' : 'border-transparent'
        }`}
      >
        {displayText ?? displayValue(value)}
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(value);
            setError(null);
            setEditing(false);
            event.currentTarget.blur();
          }
        }}
        inputMode={numeric ? 'numeric' : 'text'}
        disabled={committing}
        className={`w-full min-w-0 rounded border bg-transparent px-1.5 py-1 text-xs text-on-surface outline-none transition-colors focus:bg-surface focus:ring-1 disabled:opacity-60 ${
          error
            ? 'border-error focus:border-error focus:ring-error'
            : 'border-transparent hover:border-outline-variant focus:border-primary focus:ring-primary'
        }`}
      />
      {error && (
        <div className="mt-1 max-w-[160px] whitespace-normal text-[10px] leading-tight text-error">
          {error}
        </div>
      )}
    </div>
  );
}

function DailyScheduleContent() {
  const router = useRouter();
  const pathname = usePathname();
  const isActiveRoute = pathname === '/daily';
  const searchParams = useCachedRouteSearchParams();
  const { dialogNode, showAlert, showConfirm } = useAppDialog();
  const { notifyExportCompleted } = useExportNotifications();
  const operationalWritePending = useOperationalScheduleStore((state) => state.mutating || state.importing || Boolean(state.unresolvedAttempt));
  const operationalUnresolvedAttempt = useOperationalScheduleStore((state) => state.unresolvedAttempt);
  const targetSeasonId = searchParams.get('season');
  const requestedRange = readDailyDateRangeQuery(searchParams);
  const requestedDailyDate = normalizeDailyDateParam(searchParams.get('date'));
  const defaultRange = useMemo(
    () => requestedRange ?? buildDefaultDailyDateRange(requestedDailyDate ?? todayIso()),
    [requestedDailyDate, requestedRange],
  );
  const [fromDateTime, setFromDateTime] = useSessionState('daily:fromDateTime', defaultRange.from);
  const [toDateTime, setToDateTime] = useSessionState('daily:toDateTime', defaultRange.to);
  const initialDailyRouteState = readInitialDailyRouteState({ targetSeasonId, fromDateTime, toDateTime });

  const [seasons, setSeasons] = useState<Season[]>(() => initialDailyRouteState?.seasons ?? []);
  const [season, setSeason] = useState<Season | null>(() => initialDailyRouteState?.season ?? null);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>(() => initialDailyRouteState?.flightRecords ?? []);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(
    () => initialDailyRouteState?.modifications ?? new Map()
  );
  const [settings, setSettings] = useState<OperationalSettings | null>(() => initialDailyRouteState?.settings ?? null);
  const [loading, setLoading] = useState(() => !initialDailyRouteState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Đang tải lịch ngày...', 10, 'Đang chuẩn bị không gian làm việc')
  );
  const [dailyImporting, setDailyImportingState] = useState(false);
  const setDailyImporting = useCallback((value: boolean) => {
    if (isOperationalScheduleV1Enabled()) useOperationalScheduleStore.setState({ importing: value });
    setDailyImportingState(value);
  }, []);
  const [dailyImportCommitting, setDailyImportCommitting] = useState(false);
  const [importProgress, setImportProgress] = useState<DailyImportUploadProgress | null>(null);
  const importAbortControllerRef = useRef<AbortController | null>(null);
  const [pendingCommittedReceipt, setPendingCommittedReceipt] = useState<DailyImportCommittedResultV2 | null>(() => {
    if (typeof window === 'undefined') return null;
    const operatorId = resolveOperatorId();
    if (!operatorId) return null;
    const journal = getActiveDailyUploadJournal(operatorId);
    return journal?.status === 'committed' && journal.committedResult ? journal.committedResult : null;
  });
  const [dailyImportPreviewV2, setDailyImportPreviewV2] = useState<DailyImportStageResultV2 | null>(() => {
    if (typeof window === 'undefined') return null;
    const operatorId = resolveOperatorId();
    if (!operatorId) return null;
    const journal = getActiveDailyUploadJournal(operatorId);
    return journal?.status === 'staged' && journal.stagedResult ? journal.stagedResult : null;
  });
  const [operationalMutating, setOperationalMutatingState] = useState(false);
  const operationalMutatingRef = useRef(false);
  const setOperationalMutating = useCallback((value: boolean) => {
    operationalMutatingRef.current = value;
    setOperationalMutatingState(value);
  }, []);
  const pendingRevalidateOnSettleRef = useRef(false);
  const operationalSnapshotRef = useRef<OperationalWindowSnapshot | null>(null);
  const lastStagedV2PayloadRef = useRef<DailyImportStagePayloadV2 | null>(null);
  const pendingManualBatchRef = useRef<{ signature: string; requestId: string; legs: Array<Record<string, unknown>> } | null>(null);
  const appliedRangeQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedRange) {
      appliedRangeQueryRef.current = null;
      return;
    }
    const rangeKey = `${requestedRange.from}|${requestedRange.to}`;
    if (appliedRangeQueryRef.current === rangeKey) return;
    setFromDateTime(requestedRange.from);
    setToDateTime(requestedRange.to);
    appliedRangeQueryRef.current = rangeKey;
  }, [requestedRange, setFromDateTime, setToDateTime]);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>(
    () => initialDailyRouteState?.syncSummary ?? {
      pendingCount: 0,
      lastLocalChangeAt: null,
    }
  );
  const [filters, setFilters] = useSessionState<DailyFilterState>('daily:filters', { type: 'all' });
  const [filterDrafts, setFilterDrafts] = useSessionState<Record<DailyGridField, string>>(
    'daily:filterDrafts',
    () => emptyFilterDrafts()
  );
  const [sort, setSort] = useSessionState<DailySortState>('daily:sort', { field: 'time', direction: 'asc' });
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [isNewFlightOpen, setIsNewFlightOpen] = useState(false);
  const dailyImportInputRef = useRef<HTMLInputElement | null>(null);
  const dailyGridScrollRef = useRef<HTMLDivElement | null>(null);
  const commitQueueRef = useRef(Promise.resolve());
  const currentMutationRef = useRef<Promise<unknown> | null>(null);
  const loadedWindowKeyRef = useRef<string | null>(initialDailyRouteState?.windowKey ?? null);
  const fetchServerDataRequestRef = useRef(0);
  const latestRouteWindowRef = useRef<{ seasonId: string | null; windowKey: string }>({
    seasonId: initialDailyRouteState?.season.id ?? null,
    windowKey: initialDailyRouteState?.windowKey ?? '',
  });
  const dailyDeleteShortcutInFlightRef = useRef(false);
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow } = useSeasonSync(syncSeasonId, 'daily');
  const [fetchingServerData, setFetchingServerData] = useState(false);
  const syncInProgress = syncStatus.status === 'syncing';
  const syncing = syncInProgress && syncStatus.mode === 'manual';
  const syncWriteInProgress = syncInProgress || fetchingServerData;
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' ? syncStatus.message : null);
  const fetchProgress = fetchingServerData ? 'Fetching server data' : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);
  const currentDailyWindowKey = buildDailyWindowKey(fromDateTime, toDateTime);
  useEffect(() => {
    latestRouteWindowRef.current = {
      seasonId: season?.id ?? null,
      windowKey: currentDailyWindowKey,
    };
  }, [currentDailyWindowKey, season?.id]);

  const waitForDailyLocalCommit = useCallback(async () => {
    await currentMutationRef.current;
  }, []);

  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'daily', {
    blocked: dailyImporting,
    reason: 'Đang nhập tệp Lịch ngày',
    beforeSync: waitForDailyLocalCommit,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'daily-hydration', {
    blocked: loading,
    reason: 'Đang tải bản lưu từ máy chủ',
    quiet: true,
    blockingUi: false,
  });
  const historySeqRef = useRef(0);
  const appliedDailyDateParamRef = useRef<string | null>(null);
  useSessionScrollRestoration('daily:grid-scroll', dailyGridScrollRef);

  useEffect(() => {
    if (!requestedDailyDate) {
      appliedDailyDateParamRef.current = null;
      return;
    }
    if (appliedDailyDateParamRef.current === requestedDailyDate) return;

    const next = buildDefaultDailyDateRange(requestedDailyDate);
    setFromDateTime(next.from);
    setToDateTime(next.to);
    setSelectedRowIds(new Set());
    appliedDailyDateParamRef.current = requestedDailyDate;
  }, [requestedDailyDate, setFromDateTime, setToDateTime]);

  const publishDailyWorkspaceChange = useCallback((
    seasonId: string,
    localRevision: number | null | undefined,
    affectedIds: string[] = [],
    syncMeta: LocalSyncMeta | null = null
  ) => {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision: localRevision ?? null,
      source: 'daily',
      affectedIds,
      syncMeta,
    });
  }, []);

  const applyDailyNativeState = useCallback((
    seasonId: string,
    records: FlightRecord[],
    nextModifications: Map<string, FlightModification>,
    syncMeta: LocalSyncMeta,
    options: {
      affectedIds?: string[];
      replaceWindow?: boolean;
      season?: Season | null;
      windowKey?: string;
    } = {}
  ) => {
    setFlightRecords(records);
    setModifications(nextModifications);
    setSyncSummary({
      pendingCount: syncMeta.pendingCount,
      lastLocalChangeAt: syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(seasonId, {
      records,
      modifications: nextModifications,
    });
    const store = useSeasonWorkspaceStore.getState();
    const windowKey = options.windowKey ?? buildDailyWindowKey(fromDateTime, toDateTime);
    if (options.replaceWindow) {
      store.replaceSeasonWindow({
        seasonId,
        season: options.season,
        records,
        modifications: nextModifications,
        syncMeta,
        windowKey,
      });
      return;
    }
    store.patchSeasonWorkspace({
      seasonId,
      affectedIds: options.affectedIds,
      records,
      modifications: nextModifications,
      syncMeta,
      windowKey,
    });
  }, [fromDateTime, toDateTime]);

  const tryApplyCachedDailyRouteWindow = useCallback((): false | 'fresh' | 'stale' => {
    const storeState = useSeasonWorkspaceStore.getState();
    const cachedSeasons = getCachedSeasons() ?? storeState.seasons;
    const cachedSettings = storeState.operationalSettings;
    if (!cachedSeasons || !cachedSettings || cachedSeasons.length === 0) return false;

    const targetSeason = (targetSeasonId ? cachedSeasons.find((item) => item.id === targetSeasonId) : null) ?? cachedSeasons[0];
    if (targetSeasonId && targetSeasonId !== targetSeason.id) return false;

    const windowKey = buildDailyWindowKey(fromDateTime, toDateTime);
    const freshWindow = readCachedWorkspaceWindow(storeState.workspaces[targetSeason.id], windowKey);
    const cachedWindow = freshWindow ?? readWorkspaceWindowSnapshot(storeState.workspaces[targetSeason.id], windowKey);
    if (!cachedWindow?.syncMeta) return false;

    setLoadError(null);
    setSettings(cachedSettings);
    setSeasons(cachedSeasons);
    setSeason(targetSeason);
    loadedWindowKeyRef.current = windowKey;
    applyDailyNativeState(targetSeason.id, cachedWindow.records, cachedWindow.modifications, cachedWindow.syncMeta, {
      season: targetSeason,
      windowKey,
    });
    setLoading(false);
    return freshWindow ? 'fresh' as const : 'stale' as const;
  }, [applyDailyNativeState, fromDateTime, targetSeasonId, toDateTime]);

  const refreshDailyWindow = useCallback(async (options: { revalidate?: boolean } = {}) => {
    if (isOperationalScheduleV1Enabled()) {
      const startDate = fromDateTime.slice(0, 10);
      const endDate = toDateTime.slice(0, 10);
      useOperationalScheduleStore.setState({ startDate, endDate, resourceType: 'schedule' });
      await useOperationalScheduleStore.getState().loadWindow({ force: true });
      const current = useOperationalScheduleStore.getState();
      if (current.startDate !== startDate || current.endDate !== endDate || current.resourceType !== 'schedule') return null;
      operationalSnapshotRef.current = current.snapshot;
      setFlightRecords(current.records);
      setModifications(new Map());
      return { records: current.records, resources: current.resources, snapshot: current.snapshot };
    }
    if (!season?.id) return null;
    const windowKey = buildDailyWindowKey(fromDateTime, toDateTime);
    if (options.revalidate) {
      await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'schedule',
        limit: 100000,
      });
    }
    const snapshot = readWorkspaceWindowSnapshot(useSeasonWorkspaceStore.getState().workspaces[season.id], windowKey);
    if (!snapshot?.syncMeta) return null;
    setFlightRecords(snapshot.records);
    setModifications(new Map(snapshot.modifications));
    setSyncSummary({
      pendingCount: snapshot.syncMeta.pendingCount,
      lastLocalChangeAt: snapshot.syncMeta.lastLocalChangeAt,
    });
    patchCachedSeasonData(season.id, {
      records: snapshot.records,
      modifications: snapshot.modifications,
    });
    loadedWindowKeyRef.current = windowKey;
    return snapshot;
  }, [fromDateTime, season, toDateTime]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'daily',
    onRefresh: async (event) => {
      await refreshDailyWindow({ revalidate: event.refreshMode === 'revalidate' });
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cachedState = tryApplyCachedDailyRouteWindow();
      if (isOperationalScheduleV1Enabled()) {
        if (!isActiveRoute) return;
        setLoading(true);
        setLoadError(null);
        try {
          const loadedSettings = await getOperationalSettings().catch(() => null);
          if (cancelled) return;
          if (loadedSettings) setSettings(loadedSettings);
          const startDate = fromDateTime.slice(0, 10);
          const endDate = toDateTime.slice(0, 10);
          setLoadProgress(buildLoadProgress('Đang tải khoảng ngày vận hành', 40, `${startDate}..${endDate}`));
          await refreshDailyWindow();
          if (cancelled) return;
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          setLoading(false);
          return;
        } catch (err) {
          console.error('Error loading operational daily schedule', err);
          if (!cancelled) {
            const message = formatUiError(err, 'Không thể tải Lịch ngày vận hành.');
            setLoadError(message);
            void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
          }
          return;
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      if (cachedState === 'fresh') return;
      setLoading(cachedState !== 'stale');
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Đang tải mùa bay và cấu hình', 15, 'Đang chuẩn bị Lịch ngày'));
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
          loadedWindowKeyRef.current = null;
          setSeason(null);
          setFlightRecords([]);
          setModifications(new Map());
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          return;
        }

        const targetSeason = (targetSeasonId ? nextSeasons.find((item) => item.id === targetSeasonId) : null) ?? nextSeasons[0];
        if (targetSeasonId && targetSeasonId !== targetSeason.id) {
          router.replace(`/daily?season=${targetSeason.id}`);
          return;
        }

        setSeason(targetSeason);
        const windowKey = buildDailyWindowKey(fromDateTime, toDateTime);
        const workspace = useSeasonWorkspaceStore.getState().workspaces[targetSeason.id];
        const freshWindow = readCachedWorkspaceWindow(workspace, windowKey);
        const cachedWindow = freshWindow ?? readWorkspaceWindowSnapshot(workspace, windowKey);
        if (cachedWindow?.syncMeta) {
          loadedWindowKeyRef.current = windowKey;
          applyDailyNativeState(targetSeason.id, cachedWindow.records, cachedWindow.modifications, cachedWindow.syncMeta, {
            season: targetSeason,
            windowKey,
          });
          if (freshWindow) return;
          setLoading(false);
        }

        setLoadProgress(buildLoadProgress('Đang tải không gian làm việc máy chủ', 35, targetSeason.seasonCode));
        const serverWindow = await loadSeasonWorkspaceWindow({
          seasonId: targetSeason.id,
          dateFrom: fromDateTime.slice(0, 10),
          dateTo: toDateTime.slice(0, 10),
          resourceType: 'schedule',
          limit: 100000,
        });
        if (cancelled) return;
        if (serverWindow) {
          loadedWindowKeyRef.current = windowKey;
          setLoadProgress(buildLoadProgress(
            'Đang chuẩn bị Lịch ngày',
            80,
            `${serverWindow.records.length} bản ghi`
          ));
          applyDailyNativeState(targetSeason.id, serverWindow.records, serverWindow.modifications, serverWindow.syncMeta, {
            replaceWindow: true,
            season: targetSeason,
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

        throw new Error('Dữ liệu Lịch ngày trên máy chủ không khả dụng.');
      } catch (err) {
        console.error('Error loading daily schedule', err);
        if (!cancelled) {
          const message = formatUiError(err, 'Không thể tải dữ liệu Lịch ngày từ máy chủ.');
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
  }, [applyDailyNativeState, fromDateTime, isActiveRoute, refreshDailyWindow, router, showAlert, targetSeasonId, toDateTime, tryApplyCachedDailyRouteWindow]);
  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() || !isActiveRoute) return;
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
        if (storeState.mutating || storeState.importing || operationalMutatingRef.current) {
          pendingRevalidateOnSettleRef.current = true;
          return;
        }

        void refreshDailyWindow({ revalidate: true }).catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
      },
      onReconnect: () => {
        const storeState = useOperationalScheduleStore.getState();
        if (storeState.mutating || storeState.importing || operationalMutatingRef.current) {
          pendingRevalidateOnSettleRef.current = true;
          return;
        }
        void refreshDailyWindow({ revalidate: true }).catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
      },
    });
    return () => {
      sub.unsubscribe();
    };
  }, [isActiveRoute, refreshDailyWindow]);
  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() || !isActiveRoute) return;
    if (operationalMutating || operationalWritePending) return;
    if (pendingRevalidateOnSettleRef.current) {
      pendingRevalidateOnSettleRef.current = false;
      void refreshDailyWindow({ revalidate: true }).catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
    }
  }, [isActiveRoute, operationalMutating, operationalWritePending, refreshDailyWindow]);
  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() || !isActiveRoute) return;
    const operatorId = resolveOperatorId();
    if (!operatorId) return;
    const activeJournal = getActiveDailyUploadJournal(operatorId);
    if (activeJournal?.status === 'committed' && activeJournal.committedResult) {
      setPendingCommittedReceipt(activeJournal.committedResult);
    } else if (activeJournal?.status === 'staged' && activeJournal.requestId && !dailyImportPreviewV2) {
      if (activeJournal.stagedResult) {
        setDailyImportPreviewV2(activeJournal.stagedResult);
      }
      void getDailyScheduleImportV2Status(activeJournal.requestId).then((staged) => {
        if (staged) {
          setDailyImportPreviewV2(staged);
        }
      }).catch(() => undefined);
    }
  }, [isActiveRoute, dailyImportPreviewV2]);
  const rows = useMemo(() => buildDailyScheduleRows({
    records: flightRecords,
    modifications,
    from: fromDateTime,
    to: toDateTime,
  }), [flightRecords, fromDateTime, modifications, toDateTime]);

  const filteredRows = useMemo(() => filterDailyRows(rows, filters), [filters, rows]);
  const sortedRows = useMemo(() => sortDailyRows(filteredRows, sort), [filteredRows, sort]);
  const summary = useMemo(() => buildDailySummary(filteredRows), [filteredRows]);

  const handleExportDailyExcel = useCallback(async () => {
    if (!isOperationalScheduleV1Enabled() && !season) return;
    if (sortedRows.length === 0) {
      void showAlert({ title: 'Không có dữ liệu xuất', message: 'Không có dòng Lịch ngày nào phù hợp với khoảng ngày và bộ lọc hiện tại.', tone: 'warning' });
      return;
    }
    setExportingExcel(true);
    try {
      const workbook = buildDailyScheduleSummaryWorkbook({
        rows: sortedRows,
        routeCountries: settings?.routeCountries,
      });
      const prefix = season?.seasonCode ?? 'OPS';
      const fileName = buildDailyScheduleExportFileName(prefix, fromDateTime, toDateTime);
      const result = await saveWorkbookAsXlsx(workbook, fileName);
      notifyExportCompleted(result);
    } catch (err) {
      void showAlert({ title: 'Xuất Lịch ngày thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setExportingExcel(false);
    }
  }, [fromDateTime, notifyExportCompleted, season, settings, showAlert, sortedRows, toDateTime]);

  const allVisibleSelected = sortedRows.length > 0 && sortedRows.every((row) => selectedRowIds.has(row.id));
  const selectedRows = useMemo(() => {
    return sortedRows.filter((row) => selectedRowIds.has(row.id));
  }, [selectedRowIds, sortedRows]);
  const selectedRecordIds = useMemo(() => {
    return uniqueValues(selectedRows.flatMap((row) => getDailyRowRecordIds(row)));
  }, [selectedRows]);
  const selectedRowRecords = useMemo(() => {
    const byId = new Map<string, NonNullable<DailyScheduleRow['arr']>>();
    for (const row of selectedRows) {
      if (row.arr) byId.set(row.arr.id, row.arr);
      if (row.dep) byId.set(row.dep.id, row.dep);
    }
    return Array.from(byId.values());
  }, [selectedRows]);
  const newFlightDateSelection = useMemo<NewFlightDateSelection>(() => ({
    kind: 'range',
    dates: [fromDateTime.slice(0, 10), toDateTime.slice(0, 10)],
  }), [fromDateTime, toDateTime]);
  const hasSelectedRecords = selectedRecordIds.length > 0;
  const actionsDisabled = isOperationalScheduleV1Enabled()
    ? loading || operationalWritePending || operationalMutating
    : !season || syncWriteInProgress || dailyImporting;
  const dailyImportDisabled = !isOperationalScheduleV1Enabled()
    || loading
    || operationalWritePending
    || operationalMutating
    || dailyImporting;
  const selectedArrCount = selectedRowRecords.filter((record) => record.type === 'A').length;
  const selectedDepCount = selectedRowRecords.filter((record) => record.type === 'D').length;
  const selectedHasLinkInfo = selectedRows.some(hasDailyLinkInfo) ||
    selectedRowRecords.some((record) => Boolean(record.linkedRecordId || record.linkType));
  const canLinkSelection = selectedArrCount > 0 &&
    selectedArrCount === selectedDepCount &&
    !selectedHasLinkInfo;
  const canUnlinkSelection = selectedHasLinkInfo;

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

  const handleSort = (field: DailySortState['field']) => {
    setSort((current) => (
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' }
    ));
  };

  const handleFilterDraftChange = (field: DailyGridField, value: string) => {
    setFilterDrafts((current) => ({ ...current, [field]: value }));
    setFilters((current) => {
      if (NUMERIC_FILTER_FIELDS.has(field)) {
        if (value.trim() === '') return { ...current, [field]: null };
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return { ...current, [field]: null };
        return { ...current, [field]: parsed };
      }
      return { ...current, [field]: value };
    });
  };

  function handleAllocationNavigation(path: '/checkin' | '/gate') {
    if (isOperationalScheduleV1Enabled() && operationalWritePending) return;
    const params = new URLSearchParams();
    if (!isOperationalScheduleV1Enabled() && season) params.set('season', season.id);
    params.set('from', fromDateTime);
    params.set('to', toDateTime);
    router.push(`${path}?${params.toString()}`);
  }

  const handleToday = () => {
    const next = buildDefaultDailyDateRange(todayIso());
    setFromDateTime(next.from);
    setToDateTime(next.to);
  };

  const handleQuickRange = (days: number) => {
    setToDateTime(addDaysToLocalDateTime(fromDateTime, days));
  };

  const handleCellCommit = useCallback(async (recordId: string, field: DailyCellField, value: string) => {
    if (isOperationalScheduleV1Enabled()) {
      const pending = useOperationalScheduleStore.getState();
      if (pending.mutating || pending.importing || pending.unresolvedAttempt) throw new Error('Vui lòng chờ thao tác ghi vận hành hoàn tất.');
      const canonicalRecord = flightRecords.find((record) => record.id === recordId);
      if (!canonicalRecord) throw new Error(`Không tìm thấy chuyến bay ${recordId}`);
      const validation = validateDailyCellEdit({
        records: flightRecords,
        record: canonicalRecord,
        field,
        value,
      });
      if (!validation.valid) throw new Error(validation.message ?? 'Invalid daily schedule edit');
      const row = buildDailyScheduleRows({
        records: flightRecords, modifications, from: fromDateTime, to: toDateTime,
      }).find((item) => getDailyRowRecordIds(item).includes(recordId));
      const mapped = settings && row ? buildDailyStandGateModifications({
        row, record: canonicalRecord, field, value, settings, previousModifications: new Map(),
      }) : [];
      const mods = mapped.length ? mapped : [buildDailyCellModification(canonicalRecord, field, value)];
      const patches = mods.flatMap(({ legId, action: _action, ...updates }) => {
        const record = flightRecords.find((item) => item.id === legId);
        if (!record) throw new Error(`Không tìm thấy chuyến bay ${legId}`);
        if (updates.counter !== undefined) updates.counter = normalizeCheckInCounterList(updates.counter);
        const patch = buildOperationalLegPatchAndPreimage(record, updates);
        return patch ? [patch] : [];
      });
      setOperationalMutating(true);
      try {
        const res = await useOperationalScheduleStore.getState().applyMutations(patches);
        operationalSnapshotRef.current = useOperationalScheduleStore.getState().snapshot;
        if (res.refreshError) {
          await showAlert({ title: 'Đã lưu nhưng chưa tải lại được', message: formatUiError(res.refreshError), tone: 'error' });
        } else {
          setFlightRecords(useOperationalScheduleStore.getState().records);
        }
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season) throw new Error('Chưa chọn mùa bay để chỉnh sửa Lịch ngày');
    const seasonId = season.id;
    await enqueueLocalMutation(async () => {
      const canonicalRecord = flightRecords.find((record) => record.id === recordId);
      if (!canonicalRecord) throw new Error(`Không tìm thấy chuyến bay ${recordId}`);

      const validation = validateDailyCellEdit({
        records: flightRecords,
        record: canonicalRecord,
        field,
        value,
      });
      if (!validation.valid) throw new Error(validation.message ?? 'Invalid daily schedule edit');

      const latestRows = buildDailyScheduleRows({
        records: flightRecords,
        modifications,
        from: fromDateTime,
        to: toDateTime,
      });
      const row = latestRows.find((item) => getDailyRowRecordIds(item).includes(recordId));
      const standGateMods = settings && row
        ? buildDailyStandGateModifications({
            row,
            record: canonicalRecord,
            field,
            value,
            settings,
            previousModifications: modifications,
          })
        : [];
      const mods: FlightModification[] = standGateMods.length > 0
        ? standGateMods
        : (() => {
            const fieldMod = buildDailyCellModification(canonicalRecord, field, value);
            const previousMod = modifications.get(fieldMod.legId) ?? null;
            return [{
              ...previousMod,
              ...fieldMod,
              legId: fieldMod.legId,
              action: 'modified' as const,
            }];
          })();
      const timestamp = Date.now();
      const historyEntry: ModHistoryEntry = {
        id: `LOCAL_DAILY_${timestamp}_${++historySeqRef.current}`,
        timestamp,
        description: standGateMods.length > 1 ? `Edited daily ${field} and mapped gate` : `Edited daily ${field}`,
        changes: mods.map((mod) => ({
          legId: mod.legId,
          previousMod: modifications.get(mod.legId) ?? null,
          newMod: mod,
        })),
      };
      const nextModifications = applyModificationBatch(modifications, mods);
      const nativeSyncMeta = await runNativeScheduleMutation(seasonId, [], [], mods, {
        id: historyEntry.id,
        timestamp: historyEntry.timestamp,
        description: historyEntry.description,
      }, [], 'daily');
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const affectedIds = getAffectedIdsFromDailyModifications(mods);
      applyDailyNativeState(seasonId, flightRecords, nextModifications, nativeSyncMeta, { affectedIds });
      publishDailyWorkspaceChange(seasonId, nativeSyncMeta.localRevision, affectedIds, nativeSyncMeta);
      void appendAuditLogEntry(createFlightActionAuditFromHistory({
        season,
        module: 'daily',
        operation: historyEntry.description,
        beforeRecords: flightRecords,
        afterRecords: flightRecords,
        beforeModifications: modifications,
        afterModifications: nextModifications,
        targetRecordIds: mods.map((mod) => mod.legId),
      }));
    });
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, fromDateTime, modifications, publishDailyWorkspaceChange, season, setOperationalMutating, settings, showAlert, toDateTime]);

  const stageOperationalImport = useCallback(async (payload: DailyImportStagePayloadV2) => {
    lastStagedV2PayloadRef.current = payload;
    setDailyImporting(true);
    const abortController = new AbortController();
    importAbortControllerRef.current = abortController;
    try {
      const staged = await uploadDailyImportInChunksV2(payload, {
        onProgress: (p) => setImportProgress(p),
        signal: abortController.signal,
      });
      setDailyImportPreviewV2(staged);
    } catch (error) {
      if (!abortController.signal.aborted) {
        const recovered = await getDailyScheduleImportV2Status(payload.requestId).catch(() => null);
        if (recovered && (recovered.status === 'validated' || recovered.status === 'committed')) {
          setDailyImportPreviewV2(recovered);
          return;
        }
      }
      throw error;
    } finally {
      importAbortControllerRef.current = null;
      setDailyImporting(false);
      setImportProgress(null);
    }
  }, [setDailyImporting, setDailyImportPreviewV2]);

  const handleDailyImportFile = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!isOperationalScheduleV1Enabled()) {
      void showAlert({
        title: 'Chức năng chưa được kích hoạt',
        message: 'Chức năng nhập Lịch ngày yêu cầu bật chế độ Vận hành (Operations). Vui lòng kích hoạt cờ NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED để sử dụng.',
        tone: 'warning',
      });
      return;
    }
    if (dailyImporting || operationalWritePending || useOperationalScheduleStore.getState().importing) return;
    const operatorId = resolveOperatorId();
    if (!operatorId) {
      void showAlert({
        title: 'Yêu cầu đăng nhập',
        message: 'Vui lòng đăng nhập để thực hiện nhập Lịch ngày.',
        tone: 'warning',
      });
      return;
    }
    setDailyImporting(true);
    const abortController = new AbortController();
    importAbortControllerRef.current = abortController;
    try {
      const parseResult = await parseDailyWorkbookWithWorker(file, {
        onProgress: (p) => setImportProgress(p),
        signal: abortController.signal,
        fallbackDate: fromDateTime.slice(0, 10),
      });

      const { payload } = parseResult;

      const legDates = new Set(payload.legs.map((leg) => leg.operationalDate));
      const zeroDates = payload.affectedDates.filter((date) => !legDates.has(date));
      if (zeroDates.length > 0) {
        const confirmed = await showConfirm({
          title: 'Xác nhận ngày không có chuyến bay',
          message: `Thay thế toàn bộ chuyến bay vận hành trong ngày ${zeroDates.join(', ')} bằng lịch trống? Đợt nhập chỉ ảnh hưởng đến ngày ${payload.affectedDates.join(', ')}.`,
          tone: 'warning',
        });
        if (!confirmed) return;
        payload.confirmedZeroFlightDates = zeroDates;
      }

      await stageOperationalImport(payload);
    } catch (err) {
      if (!abortController.signal.aborted) {
        void showAlert({ title: 'Nhập Lịch ngày thất bại', message: formatUiError(err), tone: 'error' });
      }
    } finally {
      importAbortControllerRef.current = null;
      setDailyImporting(false);
      setImportProgress(null);
      if (dailyImportInputRef.current) dailyImportInputRef.current.value = '';
    }
  }, [dailyImporting, fromDateTime, operationalWritePending, setDailyImporting, showAlert, showConfirm, stageOperationalImport]);
  const handleRetryPendingMutation = useCallback(async () => {
    setOperationalMutating(true);
    try {
      const outcome = await useOperationalScheduleStore.getState().retryPendingMutation();
      if (outcome && 'refreshError' in outcome && outcome.refreshError) {
        void showAlert({ title: 'Đã lưu nhưng chưa tải lại được', message: formatUiError(outcome.refreshError), tone: 'warning' });
      } else {
        await refreshDailyWindow({ revalidate: true });
      }
    } catch (err) {
      void showAlert({ title: 'Thử lại thất bại', message: formatUiError(err), tone: 'error' });
    } finally {
      setOperationalMutating(false);
    }
  }, [refreshDailyWindow, setOperationalMutating, showAlert]);


  const handleAddFlights = useCallback(async (mods: FlightModification[]) => {
    if (isOperationalScheduleV1Enabled()) {
      setOperationalMutating(true);
      try {
        const addedRecords = buildCanonicalAddedFlightRecords(mods);
        if (addedRecords.length !== mods.length || addedRecords.length === 0) throw new Error('Added flight payload is missing leg data.');
        const inputs = addedRecords.map((record) => ({
          scheduledDate: record.scheduledDate ?? record.date,
          scheduledTime: record.scheduledTime ?? record.schedule,
          flightNumber: record.flightNumber, rawFlightNumber: record.rawFlightNumber,
          side: record.type === 'A' ? 'ARR' : 'DEP',
          airline: record.airline, route: record.route,
          aircraftType: record.aircraft, flightCategory: record.category,
          codeShares: record.codeShares, intDomInd: record.intDomInd,
          pax: record.pax ?? null, gate: record.gate ?? null,
          stand: record.stand ?? null, carousel: record.carousel ?? null,
          mct: record.mct ?? null, bhs: record.bhs ?? null, ghs: record.ghs ?? null,
          checkInStart: record.checkInStart ?? null, checkInEnd: record.checkInEnd ?? null,
          checkInAllocationMode: record.checkInAllocationMode ?? null,
          counters: flightCounterToDbCounters(record.counter),
          checkin_windows: flightWindowsToDbWindows(record.checkInCounterWindows ?? undefined),
          linkedIndex: addedRecords.findIndex((other) => other.id === record.linkedRecordId),
          linkType: record.linkType ?? null, pairAnchorDate: record.pairAnchorDate ?? null,
        }));
        const signature = JSON.stringify(inputs);
        if (pendingManualBatchRef.current?.signature !== signature) {
          const ids = inputs.map(() => crypto.randomUUID());
          const legs = inputs.map(({ linkedIndex, ...input }, index) => ({
            ...input, id: ids[index],
            linkedLegId: linkedIndex < 0 ? null : ids[linkedIndex],
            turnaroundId: linkedIndex < 0 ? null : `TRN_OPS_${ids[Math.min(index, linkedIndex)]}`,
          }));
          pendingManualBatchRef.current = { signature, requestId: crypto.randomUUID(), legs };
        }
        const batch = pendingManualBatchRef.current;
        const outcome = await useOperationalScheduleStore.getState().createFlightLegs(batch.legs, { requestId: batch.requestId });
        pendingManualBatchRef.current = null;
        setSelectedRowIds(new Set());
        if (outcome.refreshError) {
          void showAlert({ title: 'Đã tạo chuyến bay — Đang chờ tải lại', message: formatUiError(outcome.refreshError), tone: 'warning' });
        } else {
          setFlightRecords(useOperationalScheduleStore.getState().records);
        }
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress) return;
    const seasonId = season.id;
    try {
      await enqueueLocalMutation(async () => {
        const addedRecords = buildCanonicalAddedFlightRecords(mods);
        if (addedRecords.length !== mods.length) {
          throw new Error('Added flight payload is missing leg data.');
        }

        assertNoDuplicateFlightNumbersForEffectiveRecords(
          flightRecords,
          modifications,
          addedRecords
        );
        const existingRecordsById = new Map(flightRecords.map((record) => [record.id, record]));
        const addedRecordIds = new Set(addedRecords.map((record) => record.id));
        const nextRecords = [
          ...flightRecords.filter((record) => !addedRecordIds.has(record.id)),
          ...addedRecords,
        ];
        const timestamp = Date.now();
        const historyEntry: ModHistoryEntry = {
          id: `LOCAL_DAILY_ADD_${timestamp}_${++historySeqRef.current}`,
          timestamp,
          description: `Added ${addedRecords.length} flight occurrence(s)`,
          changes: [],
          recordChanges: addedRecords.map((record) => ({
            recordId: record.id,
            previousRecord: existingRecordsById.get(record.id) ?? null,
            newRecord: record,
          })),
        };
        const nativeSyncMeta = await runNativeScheduleMutation(
          seasonId,
          addedRecords,
          [],
          [],
          {
            id: historyEntry.id,
            timestamp: historyEntry.timestamp,
            description: historyEntry.description,
          },
          [],
          'daily'
        );
        if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
        const affectedIds = addedRecords.map((record) => record.id);
        applyDailyNativeState(seasonId, nextRecords, modifications, nativeSyncMeta, { affectedIds });
        publishDailyWorkspaceChange(seasonId, nativeSyncMeta.localRevision, affectedIds, nativeSyncMeta);
        setSelectedRowIds(new Set());
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season,
          module: 'daily',
          operation: historyEntry.description,
          beforeRecords: flightRecords,
          afterRecords: nextRecords,
          targetRecordIds: affectedIds,
        }));
      });
    } catch (err) {
      void showAlert({ title: 'Thêm chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, setOperationalMutating, showAlert, syncWriteInProgress]);

  const handleDeleteSelected = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      if (selectedRecordIds.length === 0) return;
      const shouldDelete = await showConfirm({
        title: 'Xóa chuyến bay đã chọn',
        message: `Bạn có chắc chắn muốn xóa ${selectedRecordIds.length} chuyến bay đã chọn?`,
        tone: 'warning',
        confirmLabel: 'Xóa',
      });
      if (!shouldDelete) return;
      setOperationalMutating(true);
      try {
        const unlinked = unlinkFlightRecords(flightRecords, selectedRecordIds);
        const affectedIds = new Set([...selectedRecordIds, ...unlinked.updatedRecords.map((record) => record.id)]);
        const patches = flightRecords.filter((record) => affectedIds.has(record.id)).flatMap((record) => {
          const patch = buildOperationalLegPatchAndPreimage(record, {
            ...(selectedRecordIds.includes(record.id) ? { status: 'deleted', deletion_reason: 'manual_delete' } : {}),
            linked_leg_id: null, turnaround_id: null, link_type: null, pair_anchor_date: null,
          });
          return patch ? [patch] : [];
        });
        if (patches.length > 0) {
          const store = useOperationalScheduleStore.getState();
          await store.applyMutations(patches);
          await refreshDailyWindow({ revalidate: true });
          setSelectedRowIds(new Set());
        }
      } catch (err) {
        void showAlert({ title: 'Xóa chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress || selectedRecordIds.length === 0) return;
    const shouldDelete = await showConfirm({
      title: 'Xóa chuyến bay đã chọn',
      message: `Bạn có chắc chắn muốn xóa ${selectedRecordIds.length} chuyến bay đã chọn?`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!shouldDelete) return;
    const seasonId = season.id;
    const ids = [...selectedRecordIds];
    try {
      await enqueueLocalMutation(async () => {
        const recordIds = new Set(flightRecords.map((record) => record.id));
        const mods: FlightModification[] = ids
          .filter((id) => recordIds.has(id))
          .map((legId) => ({ legId, action: 'deleted' }));
        if (mods.length === 0) throw new Error('Selected daily flights were not found.');
        const timestamp = Date.now();
        const historyEntry: ModHistoryEntry = {
          id: `LOCAL_DAILY_DELETE_${timestamp}_${++historySeqRef.current}`,
          timestamp,
          description: `Deleted ${mods.length} flight occurrence(s)`,
          changes: mods.map((mod) => ({
            legId: mod.legId,
            previousMod: modifications.get(mod.legId) ?? null,
            newMod: mod,
          })),
        };
        const nextModifications = applyModificationBatch(modifications, mods);
        const nativeSyncMeta = await runNativeScheduleMutation(seasonId, [], [], mods, {
          id: historyEntry.id,
          timestamp: historyEntry.timestamp,
          description: historyEntry.description,
        }, [], 'daily');
        if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
        const affectedIds = getAffectedIdsFromDailyModifications(mods);
        applyDailyNativeState(seasonId, flightRecords, nextModifications, nativeSyncMeta, { affectedIds });
        publishDailyWorkspaceChange(seasonId, nativeSyncMeta.localRevision, affectedIds, nativeSyncMeta);
        setSelectedRowIds(new Set());
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season,
          module: 'daily',
          operation: historyEntry.description,
          beforeRecords: flightRecords,
          afterRecords: flightRecords,
          beforeModifications: modifications,
          afterModifications: nextModifications,
          targetRecordIds: affectedIds,
        }));
      });
    } catch (err) {
      void showAlert({ title: 'Xóa chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, refreshDailyWindow, season, selectedRecordIds, setOperationalMutating, showAlert, showConfirm, syncWriteInProgress]);

  useEffect(() => {
    if (!isOperationalScheduleV1Enabled() && !season) return undefined;
    const handleDeleteShortcut = async (event: KeyboardEvent) => {
      if (
        event.key !== 'Delete' ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        dailyDeleteShortcutInFlightRef.current ||
        actionsDisabled ||
        !hasSelectedRecords
      ) {
        return;
      }
      event.preventDefault();
      dailyDeleteShortcutInFlightRef.current = true;
      try {
        await handleDeleteSelected();
      } finally {
        dailyDeleteShortcutInFlightRef.current = false;
      }
    };
    window.addEventListener('keydown', handleDeleteShortcut);
    return () => window.removeEventListener('keydown', handleDeleteShortcut);
  }, [actionsDisabled, handleDeleteSelected, hasSelectedRecords, season]);

  const handleLinkSelected = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      if (selectedRecordIds.length === 0) return;
      setOperationalMutating(true);
      try {
        const selected = selectedRecordIds
          .map((id) => flightRecords.find((record) => record.id === id))
          .filter((record): record is FlightRecord => record != null && record.status === 'active');
        const arrivals = selected.filter((record) => record.type === 'A');
        const departures = selected.filter((record) => record.type === 'D');
        if (arrivals.length === 0 || departures.length === 0 || arrivals.length !== departures.length) {
          throw new Error('Ghép cặp yêu cầu số lượng chuyến ĐẾN và ĐI bằng nhau và lớn hơn 0.');
        }
        const linkType = inferDailyLinkType(arrivals, departures);
        const result = linkFlightRecordPairs(
          flightRecords,
          arrivals.map((record) => record.id),
          departures.map((record) => record.id),
          linkType
        );
        const patches: OperationalLegChangeInput[] = [];
        for (const updated of result.updatedRecords) {
          const orig = flightRecords.find((r) => r.id === updated.id);
          if (orig) {
            const patch = buildOperationalLegPatchAndPreimage(orig, {
              turnaround_id: updated.turnaroundId ?? null,
              linked_leg_id: updated.linkedRecordId ?? null,
              link_type: updated.linkType ?? null,
              pair_anchor_date: updated.pairAnchorDate ?? null,
            });
            if (patch) patches.push(patch);
          }
        }
        if (patches.length > 0) {
          const store = useOperationalScheduleStore.getState();
          await store.applyMutations(patches);
          await refreshDailyWindow({ revalidate: true });
          setSelectedRowIds(new Set());
        }
      } catch (err) {
        void showAlert({ title: 'Ghép cặp chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress || selectedRecordIds.length === 0) return;
    const seasonId = season.id;
    const ids = [...selectedRecordIds];
    try {
      await enqueueLocalMutation(async () => {
        const selected = ids
          .map((id) => flightRecords.find((record) => record.id === id))
          .filter((record): record is FlightRecord => record != null && record.status === 'active');
        const arrivals = selected.filter((record) => record.type === 'A');
        const departures = selected.filter((record) => record.type === 'D');
        if (arrivals.length === 0 || departures.length === 0 || arrivals.length !== departures.length) {
          throw new Error('Ghép cặp yêu cầu số lượng chuyến ĐẾN và ĐI bằng nhau và lớn hơn 0.');
        }

        const linkType = inferDailyLinkType(arrivals, departures);
        const result = linkFlightRecordPairs(
          flightRecords,
          arrivals.map((record) => record.id),
          departures.map((record) => record.id),
          linkType
        );
        const timestamp = Date.now();
        const historyEntry = buildFlightRecordHistoryEntry({
          id: `LOCAL_DAILY_LINK_${timestamp}_${++historySeqRef.current}`,
          timestamp,
          description: `Linked ${result.updatedRecords.length} ${linkType} flight occurrence(s)`,
          beforeRecords: flightRecords,
          afterRecords: result.records,
        });
        const nativeSyncMeta = await runNativeScheduleMutation(
          seasonId,
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
          'daily'
        );
        if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
        applyDailyNativeState(seasonId, result.records, modifications, nativeSyncMeta, { affectedIds: result.updatedIds });
        publishDailyWorkspaceChange(seasonId, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
        setSelectedRowIds(new Set());
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season,
          module: 'daily',
          operation: historyEntry?.description ?? `Linked ${result.updatedRecords.length} ${linkType} flight occurrence(s)`,
          beforeRecords: flightRecords,
          afterRecords: result.records,
          targetRecordIds: result.updatedIds,
        }));
      });
    } catch (err) {
      void showAlert({ title: 'Ghép cặp chuyến bay thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, refreshDailyWindow, season, selectedRecordIds, setOperationalMutating, showAlert, syncWriteInProgress]);

  const handleUnlinkSelected = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      if (selectedRecordIds.length === 0) return;
      const shouldUnlink = await showConfirm({
        title: 'Hủy ghép cặp chuyến bay đã chọn',
        message: `Hủy ghép cặp cho ${selectedRecordIds.length} chuyến bay đã chọn?`,
        tone: 'warning',
        confirmLabel: 'Hủy ghép cặp',
      });
      if (!shouldUnlink) return;
      setOperationalMutating(true);
      try {
        const result = unlinkFlightRecords(flightRecords, [...selectedRecordIds]);
        const patches: OperationalLegChangeInput[] = [];
        for (const updated of result.updatedRecords) {
          const orig = flightRecords.find((r) => r.id === updated.id);
          if (orig) {
            const patch = buildOperationalLegPatchAndPreimage(orig, {
              turnaround_id: null,
              linked_leg_id: null,
              link_type: null,
              pair_anchor_date: null,
            });
            if (patch) patches.push(patch);
          }
        }
        if (patches.length > 0) {
          const store = useOperationalScheduleStore.getState();
          await store.applyMutations(patches);
          await refreshDailyWindow({ revalidate: true });
          setSelectedRowIds(new Set());
        }
      } catch (err) {
        void showAlert({ title: 'Hủy ghép cặp thất bại', message: formatUiError(err), tone: 'error' });
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress || selectedRecordIds.length === 0) return;
    const shouldUnlink = await showConfirm({
      title: 'Hủy ghép cặp chuyến bay đã chọn',
      message: `Hủy ghép cặp cho ${selectedRecordIds.length} chuyến bay đã chọn?`,
      tone: 'warning',
      confirmLabel: 'Hủy ghép cặp',
    });
    if (!shouldUnlink) return;
    const seasonId = season.id;
    const ids = [...selectedRecordIds];
    try {
      await enqueueLocalMutation(async () => {
        const result = unlinkFlightRecords(flightRecords, ids);
        const timestamp = Date.now();
        const historyEntry = buildFlightRecordHistoryEntry({
          id: `LOCAL_DAILY_UNLINK_${timestamp}_${++historySeqRef.current}`,
          timestamp,
          description: `Unlinked ${result.updatedRecords.length} flight occurrence(s)`,
          beforeRecords: flightRecords,
          afterRecords: result.records,
        });
        const nativeSyncMeta = await runNativeScheduleMutation(
          seasonId,
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
          'daily'
        );
        if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
        applyDailyNativeState(seasonId, result.records, modifications, nativeSyncMeta, { affectedIds: result.updatedIds });
        publishDailyWorkspaceChange(seasonId, nativeSyncMeta.localRevision, result.updatedIds, nativeSyncMeta);
        setSelectedRowIds(new Set());
        void appendAuditLogEntry(createFlightActionAuditFromHistory({
          season,
          module: 'daily',
          operation: historyEntry?.description ?? `Unlinked ${result.updatedRecords.length} flight occurrence(s)`,
          beforeRecords: flightRecords,
          afterRecords: result.records,
          targetRecordIds: result.updatedIds,
        }));
      });
    } catch (err) {
      void showAlert({ title: 'Hủy ghép cặp thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, refreshDailyWindow, season, selectedRecordIds, setOperationalMutating, showAlert, showConfirm, syncWriteInProgress]);

  const handleSync = useCallback(async () => {
    if (!season || syncInProgress) return;
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Đồng bộ thất bại', message: formatUiError(result.message ?? 'Đồng bộ thất bại.'), tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Đồng bộ thất bại', message: formatUiError(err), tone: 'error' });
    }
  }, [season, showAlert, syncInProgress, syncNow]);

  const fetchServerData = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      await refreshDailyWindow({ revalidate: true });
      return;
    }
    if (!season || fetchingServerData || syncInProgress) return;
    const windowKey = buildDailyWindowKey(fromDateTime, toDateTime);
    const requestId = ++fetchServerDataRequestRef.current;
    const requestedSeasonId = season.id;
    const hasRouteDataLoaded = loadedWindowKeyRef.current === windowKey;
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
        resourceType: 'schedule',
        limit: 100000,
      }, {
        force: true,
        initiator: 'immediate',
      });
      if (!serverWindow?.syncMeta) throw new Error('Dữ liệu Lịch ngày trên máy chủ không khả dụng.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== windowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = windowKey;
      setLoadProgress(buildLoadProgress('Đang chuẩn bị Lịch ngày', 80, `${serverWindow.records.length} bản ghi`));
      applyDailyNativeState(season.id, serverWindow.records, serverWindow.modifications, serverWindow.syncMeta, {
        replaceWindow: true,
        season,
        windowKey,
      });
      publishSeasonWorkspaceChanged({
        seasonId: season.id,
        localRevision: serverWindow.syncMeta.localRevision,
        source: 'server-window',
        syncMeta: serverWindow.syncMeta,
      });
    } catch (err) {
      const message = formatUiError(err, 'Không thể tải dữ liệu Lịch ngày từ máy chủ.');
      if (!hasRouteDataLoaded) setLoadError(message);
      void showAlert({ title: 'Tải dữ liệu thất bại', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [applyDailyNativeState, fetchingServerData, fromDateTime, refreshDailyWindow, season, showAlert, syncInProgress, toDateTime]);

  return (
    <div className="flex h-dvh bg-surface text-on-surface overflow-hidden font-sans">
      <div className="flex-1 flex flex-col min-w-0 bg-surface h-dvh overflow-hidden">
        <header className="flex-none flex items-center justify-between px-6 py-3 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm z-30">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Lịch ngày</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {isOperationalScheduleV1Enabled() ? 'Lịch ngày vận hành' : (season ? buildSeasonDisplayLabel(season) : 'Chưa chọn mùa bay')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!isOperationalScheduleV1Enabled() && (
              <select
                value={season?.id ?? ''}
                onChange={(event) => router.push(`/daily?season=${event.target.value}`)}
                disabled={seasons.length === 0 || syncing}
                className="px-3 py-2 bg-surface-container-low hover:bg-surface-container-high border border-outline-variant text-on-surface font-label-caps text-sm font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-colors cursor-pointer shadow-sm min-w-[200px]"
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
                <span className={`px-2 py-1 rounded-full text-xs font-semibold border ${
                  syncTone === 'error'
                    ? 'bg-red-50 text-red-800 border-red-200'
                    : syncTone === 'info'
                      ? 'bg-sky-50 text-sky-800 border-sky-200'
                      : syncTone === 'warning'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-200'
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
        {operationalUnresolvedAttempt && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-6 py-2.5 text-sm text-on-surface">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-warning">warning</span>
              <p className="text-pretty">
                Có thao tác vận hành chưa xác nhận trên máy chủ (Mã yêu cầu {operationalUnresolvedAttempt.requestId.slice(0, 8)}…). Các thao tác khác đang bị tạm khóa.
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
        {dailyImporting && importProgress && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-4 border-b border-primary/30 bg-surface-container-highest px-6 py-3 text-sm shadow-sm">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined animate-spin text-primary text-xl">sync</span>
              <div>
                <p className="font-semibold text-on-surface">{importProgress.message}</p>
                {importProgress.detail && <p className="text-xs text-on-surface-variant">{importProgress.detail}</p>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-36 bg-surface-container rounded-full h-2 overflow-hidden border border-outline-variant">
                <div className="bg-primary h-full transition-all duration-200" style={{ width: `${importProgress.percent}%` }} />
              </div>
              <span className="text-xs font-mono font-semibold text-primary">{importProgress.percent}%</span>
              <button
                type="button"
                onClick={() => importAbortControllerRef.current?.abort()}
                className="rounded border border-outline-variant px-2.5 py-1 text-xs font-medium hover:bg-surface-container-high"
              >
                Hủy
              </button>
            </div>
          </div>
        )}
        {pendingCommittedReceipt && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-surface-container-high px-6 py-3 text-sm">
            <p className="text-pretty">Đợt nhập {pendingCommittedReceipt.batchId} đã được lưu thành công trên máy chủ nhưng dữ liệu hiển thị chưa được tải lại.</p>
            <button
              type="button"
              disabled={loading || operationalMutating}
              onClick={async () => {
                try {
                  await refreshDailyWindow({ revalidate: true });
                  const operatorId = resolveOperatorId();
                  if (operatorId) clearDailyUploadJournal(operatorId);
                  setPendingCommittedReceipt(null);
                } catch (err) {
                  void showAlert({ title: 'Tải lại thất bại', message: formatUiError(err), tone: 'error' });
                }
              }}
              className="rounded border border-primary px-3 py-2 font-semibold text-primary disabled:opacity-50"
            >
              {loading ? 'Đang tải lại…' : 'Tải lại dữ liệu đã lưu'}
            </button>
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-hidden p-4 flex flex-col gap-3">
          <section className="flex-none rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-surface-variant">
              <fieldset disabled={isOperationalScheduleV1Enabled() && operationalWritePending} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  Từ
                  <input
                    type="datetime-local"
                    value={fromDateTime}
                    onChange={(event) => {
                      const nextFrom = event.target.value;
                      setFromDateTime(nextFrom);
                      if (nextFrom) setToDateTime(addDaysToLocalDateTime(nextFrom, 1));
                    }}
                    className="bg-surface-container border border-outline-variant rounded px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  Đến
                  <input
                    type="datetime-local"
                    value={toDateTime}
                    onChange={(event) => setToDateTime(event.target.value)}
                    className="bg-surface-container border border-outline-variant rounded px-2 py-1.5 text-sm text-on-surface"
                  />
                </label>
                {isOperationalScheduleV1Enabled() ? (
                  <>
                    <button
                      onClick={() => {
                        const range = buildOperationalDateRange('today');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">today</span>
                      Hôm nay
                    </button>
                    <button
                      onClick={() => {
                        const range = buildOperationalDateRange('tomorrow');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                      Ngày mai
                    </button>
                    <button
                      onClick={() => {
                        const range = buildOperationalDateRange('next7days');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                      7 ngày
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={handleToday} className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors">
                      <span className="material-symbols-outlined text-[16px]">today</span>
                      Hôm nay
                    </button>
                    {[1, 2, 7].map((days) => (
                      <button
                        key={days}
                        onClick={() => handleQuickRange(days)}
                        className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                      >
                        {days}N
                      </button>
                    ))}
                  </>
                )}
                <button
                  disabled={!isOperationalScheduleV1Enabled() && !season}
                  onClick={() => handleAllocationNavigation('/checkin')}
                  title="Mở Phân bổ quầy cho khoảng ngày hiện tại"
                  aria-label="Mở Phân bổ quầy cho khoảng ngày hiện tại"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">countertops</span>
                </button>
                <button
                  disabled={!isOperationalScheduleV1Enabled() && !season}
                  onClick={() => handleAllocationNavigation('/gate')}
                  title="Mở Phân bổ cửa cho khoảng ngày hiện tại"
                  aria-label="Mở Phân bổ cửa cho khoảng ngày hiện tại"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PbbIcon className="h-[19px] w-[19px]" />
                </button>
              </fieldset>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-container px-3 py-1 text-xs font-bold text-on-primary-container">ĐẾN {summary.arr}</span>
                <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">ĐI {summary.dep}</span>
                <span className="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container">TỔNG {summary.total}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <input
                  ref={dailyImportInputRef}
                  type="file"
                  accept=".xls,.xlsx"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    void handleDailyImportFile(file);
                  }}
                />
                <button
                  onClick={() => {
                    if (!isOperationalScheduleV1Enabled()) {
                      void showAlert({
                        title: 'Chức năng chưa được kích hoạt',
                        message: 'Chức năng nhập Lịch ngày yêu cầu bật chế độ Vận hành (Operations). Vui lòng kích hoạt cờ NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED để sử dụng.',
                        tone: 'warning',
                      });
                      return;
                    }
                    dailyImportInputRef.current?.click();
                  }}
                  disabled={dailyImportDisabled}
                  title={!isOperationalScheduleV1Enabled() ? 'Chức năng nhập Lịch ngày yêu cầu bật chế độ Vận hành (Operations).' : 'Nhập Lịch ngày (.xls hoặc .xlsx)'}
                  aria-label="Nhập tệp Lịch ngày"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[19px] ${dailyImporting ? 'animate-spin' : ''}`}>
                    {dailyImporting ? 'sync' : 'upload_file'}
                  </span>
                </button>
                <button
                  onClick={() => void handleExportDailyExcel()}
                  disabled={(!isOperationalScheduleV1Enabled() && !season) || exportingExcel || sortedRows.length === 0}
                  title="Xuất Lịch ngày đang hiển thị ra Excel"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[18px] ${exportingExcel ? 'animate-spin' : ''}`}>
                    {exportingExcel ? 'sync' : 'download'}
                  </span>
                  Xuất Excel
                </button>
                <button
                  onClick={() => setIsNewFlightOpen(true)}
                  disabled={actionsDisabled}
                  title="Thêm chuyến bay"
                  aria-label="Thêm chuyến bay"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">add</span>
                </button>
                <button
                  onClick={() => void handleLinkSelected()}
                  disabled={actionsDisabled || !canLinkSelection}
                  title="Ghép cặp chuyến bay đã chọn"
                  aria-label="Ghép cặp chuyến bay đã chọn"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link</span>
                </button>
                <button
                  onClick={() => void handleUnlinkSelected()}
                  disabled={actionsDisabled || !canUnlinkSelection}
                  title="Hủy ghép cặp chuyến bay đã chọn"
                  aria-label="Hủy ghép cặp chuyến bay đã chọn"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link_off</span>
                </button>
                <button
                  onClick={() => void handleDeleteSelected()}
                  disabled={actionsDisabled || !hasSelectedRecords}
                  title="Xóa chuyến bay đã chọn"
                  aria-label="Xóa chuyến bay đã chọn"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-error/40 bg-surface-container text-error transition-colors hover:bg-error-container hover:text-on-error-container disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">delete</span>
                </button>
              </div>
              <input
                value={filters.query ?? ''}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                placeholder="Tìm chuyến bay, đường bay, tàu bay..."
                className="min-w-[280px] flex-1 bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
              />
              <select
                value={filters.type ?? 'all'}
                onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value as DailyFilterState['type'] }))}
                className="bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm"
              >
                <option value="all">Tất cả</option>
                <option value="arrivals">Chuyến đến</option>
                <option value="departures">Chuyến đi</option>
              </select>
            </div>
          </section>

          <section className="flex-1 min-h-0 rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm overflow-hidden">
            {loading ? (
              <LoadingStatusPanel progress={loadProgress} className="h-full min-h-[320px]" />
            ) : loadError ? (
              <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="font-body-sm text-body-sm font-semibold text-error">Không thể tải Lịch ngày</div>
                <div className="max-w-xl font-body-sm text-body-sm text-on-surface-variant">{loadError}</div>
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
              <div className="flex h-full flex-col items-center justify-center gap-3 text-on-surface-variant">
                <div>Chưa chọn mùa bay. Hãy nhập tệp Lịch ngày vận hành để tạo mùa bay.</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingServerData}
                    progress={fetchProgress}
                    disabled={syncInProgress}
                    onFetch={fetchServerData}
                  />
                )}
              </div>
            ) : (
              <div ref={dailyGridScrollRef} className="h-full overflow-auto">
                <table className="w-full min-w-[1840px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-20 bg-surface-container-low shadow-sm">
                    <tr className="border-b border-surface-variant">
                      <th className="w-10 px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={(event) => {
                            setSelectedRowIds((current) => {
                              const next = new Set(current);
                              sortedRows.forEach((row) => {
                                if (event.target.checked) next.add(row.id);
                                else next.delete(row.id);
                              });
                              return next;
                            });
                          }}
                          aria-label="Chọn tất cả dòng đang hiển thị"
                          className="h-4 w-4 rounded border-outline text-primary focus:ring-primary"
                        />
                      </th>
                      {GRID_COLUMNS.map((column) => (
                        <th key={column.field} className={`px-2 py-2 align-top font-label-caps text-label-caps text-on-surface-variant ${column.className ?? ''}`}>
                          <button
                            onClick={() => handleSort(column.field)}
                            className="flex w-full items-center justify-between gap-1 text-left hover:text-primary"
                          >
                            <span>{column.label}</span>
                            <span className="material-symbols-outlined text-[15px]">
                              {sort.field === column.field ? (sort.direction === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                            </span>
                          </button>
                          <input
                            value={filterDrafts[column.field]}
                            onChange={(event) => handleFilterDraftChange(column.field, event.target.value)}
                            inputMode={column.numeric ? 'numeric' : 'text'}
                            placeholder={column.numeric ? 'Số' : 'Lọc'}
                            className="mt-2 w-full rounded border border-outline-variant bg-surface-container-highest px-2 py-1 text-xs font-normal text-on-surface focus:outline-none focus:border-primary"
                          />
                        </th>
                      ))}
                      <th className="min-w-[96px] px-2 py-2 align-top font-label-caps text-label-caps text-on-surface-variant">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-variant font-data-tabular text-data-tabular text-on-surface">
                    {sortedRows.length === 0 ? (
                      <tr>
                        <td colSpan={GRID_COLUMNS.length + 2} className="px-4 py-10 text-center text-on-surface-variant">
                          Không có dòng nào phù hợp với bộ lọc Lịch ngày hiện tại.
                        </td>
                      </tr>
                    ) : sortedRows.map((row) => (
                      <tr key={row.id} className="hover:bg-primary-container/10 transition-colors">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedRowIds.has(row.id)}
                            onChange={(event) => {
                              setSelectedRowIds((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(row.id);
                                else next.delete(row.id);
                                return next;
                              });
                            }}
                            aria-label={`Chọn chuyến ${row.arr?.flightNumber ?? row.dep?.flightNumber ?? 'này'}`}
                            className="h-4 w-4 rounded border-outline text-primary focus:ring-primary"
                          />
                        </td>
                        {GRID_COLUMNS.map((column) => {
                          const target = editableCellTarget(row, column.field);
                          return (
                            <td key={column.field} className="px-2 py-1.5 whitespace-nowrap align-top">
                              {target ? (
                                <EditableCell
                                  key={`${target.recordId}:${target.field}:${editableCellValue(row, column.field)}`}
                                  value={editableCellValue(row, column.field)}
                                  displayText={rowValue(row, column.field)}
                                  numeric={column.numeric}
                                  onCommit={(value) => handleCellCommit(target.recordId, target.field, value)}
                                />
                              ) : rowValue(row, column.field)}
                            </td>
                          );
                        })}
                        <td className="px-2 py-2 text-on-surface-variant">
                          <span className="inline-flex items-center gap-1 rounded-full border border-outline-variant px-2 py-1 text-[11px] font-semibold">
                            <span className="material-symbols-outlined text-[14px]">
                              {selectedRowIds.has(row.id) ? 'check_circle' : row.arr && row.dep ? 'sync_alt' : 'radio_button_unchecked'}
                            </span>
                            {rowActionLabel(row, selectedRowIds.has(row.id))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
      <NewFlightModal
        isOpen={isNewFlightOpen}
        onClose={() => setIsNewFlightOpen(false)}
        mode="detailed"
        prefill={null}
        prefillLinked={null}
        prefillDateSelection={newFlightDateSelection}
        onSubmitDetailed={handleAddFlights}
      />
      {dailyImportPreviewV2 && (
        <DailyImportPreviewDialogV2
          result={dailyImportPreviewV2}
          commitEnabled={!operationalWritePending}
          committing={dailyImporting}
          onCancel={async () => {
            if (useOperationalScheduleStore.getState().importing || dailyImporting) return;
            const batchId = dailyImportPreviewV2.batchId;
            if (dailyImportPreviewV2.status !== 'committed') {
              setDailyImporting(true);
              try {
                await cancelDailyScheduleImportV2(batchId);
              } catch (error) {
                void showAlert({ title: 'Hủy thao tác chưa được xác nhận', message: formatUiError(error), tone: 'warning' });
                return;
              } finally {
                setDailyImporting(false);
              }
            }
            const operatorId = resolveOperatorId();
            if (operatorId) clearDailyUploadJournal(operatorId);
            setDailyImportPreviewV2(null);
          }}
          onCommit={async () => {
            const pending = useOperationalScheduleStore.getState();
            if (pending.importing || pending.mutating || pending.unresolvedAttempt || dailyImportPreviewV2.status !== 'validated') return;
            const operatorId = resolveOperatorId();
            if (!operatorId) {
              void showAlert({
                title: 'Yêu cầu đăng nhập',
                message: 'Vui lòng đăng nhập để lưu đợt nhập.',
                tone: 'warning',
              });
              return;
            }
            setDailyImporting(true);
            try {
              let receipt;
              try {
                const committed = await commitDailyScheduleImportV2({
                  batchId: dailyImportPreviewV2.batchId,
                  previewHash: dailyImportPreviewV2.previewHash,
                });
                if (committed.status !== 'committed' || !committed.result) throw new Error('Chưa nhận được biên nhận lưu dữ liệu; hãy kiểm tra trạng thái đợt nhập trước khi thử lại.');
                receipt = committed.result;
              } catch (error) {
                const recovered = await getDailyScheduleImportV2Status(dailyImportPreviewV2.requestId).catch(() => null);
                if (recovered) setDailyImportPreviewV2(recovered);
                if (recovered?.status !== 'committed' || !recovered.result) throw error;
                receipt = recovered.result;
              }

              const activeJournal = getActiveDailyUploadJournal(operatorId);
              if (activeJournal) {
                try {
                  saveDailyUploadJournal({
                    ...activeJournal,
                    status: 'committed',
                    committedResult: receipt,
                  });
                } catch {
                  // Storage failure after committed RPC must NOT overwrite status as failure or delete precommit request.
                }
              }

              setDailyImportPreviewV2(null);
              useOperationalScheduleStore.setState({ snapshot: { revision: receipt.revision, token: '' } });
              setSelectedRowIds(new Set());
              try {
                await refreshDailyWindow({ revalidate: true });
                if (operatorId) clearDailyUploadJournal(operatorId);
                setPendingCommittedReceipt(null);
                void showAlert({ title: 'Hoàn tất nhập Lịch ngày', message: `Đã lưu thành công đợt ${receipt.batchId}.`, tone: 'success' });
              } catch (refreshError) {
                setPendingCommittedReceipt(receipt);
                void showAlert({
                  title: 'Đã lưu đợt nhập — Đang chờ tải lại',
                  message: `Đợt ${receipt.batchId} đã được lưu trên máy chủ. Hãy tải lại dữ liệu; không cần nhập lại. ${formatUiError(refreshError)}`,
                  tone: 'warning',
                });
              }
            } catch (commitErr) {
              void showAlert({ title: 'Lưu đợt nhập thất bại', message: formatUiError(commitErr), tone: 'error' });
            } finally {
              setDailyImporting(false);
            }
          }}
          onConfirmZeroFlightDates={async (dates) => {
            if (!lastStagedV2PayloadRef.current || useOperationalScheduleStore.getState().importing) return;
            setDailyImporting(true);
            try {
              await cancelDailyScheduleImportV2(dailyImportPreviewV2.batchId);
              const payloadWithZero: DailyImportStagePayloadV2 = {
                ...lastStagedV2PayloadRef.current,
                confirmedZeroFlightDates: dates,
                requestId: crypto.randomUUID(),
              };
              await stageOperationalImport(payloadWithZero);
            } catch (err) {
              void showAlert({ title: 'Chuẩn bị lại thất bại', message: formatUiError(err), tone: 'error' });
            } finally {
              setDailyImporting(false);
            }
          }}
        />
      )}
      {dialogNode}
    </div>
  );
}

export default function DailyPage() {
  return (
    <Suspense fallback={
      <LoadingStatusPanel
        progress={buildLoadProgress('Đang tải lịch ngày...', 20, 'Đang chuẩn bị giao diện')}
        mode="fullscreen"
      />
    }>
      <DailyScheduleContent />
    </Suspense>
  );
}
