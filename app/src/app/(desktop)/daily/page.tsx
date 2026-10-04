'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import {
  cancelDailyScheduleImportV1,
  commitDailyScheduleImportV1,
  getDailyScheduleImportV1Status,
  getOperationalSettings,
  getSeasons,
  loadSeasonWorkspaceWindow,
  stageDailyScheduleImportV1,
} from '@/lib/remoteStore';
import {
  cancelDailyScheduleImportV2,
  commitDailyScheduleImportV2,
  getDailyScheduleImportV2Status,
  stageDailyScheduleImportV2,
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
import { analyzeDailyScheduleWorkbook } from '@/lib/dailyScheduleWorkbook';
import {
  buildDailyImportStagePayloadV1,
  confirmDailyImportZeroFlightDatesV1,
  DAILY_RESOURCE_POLICY_VERSION,
  sha256Hex,
  type DailyImportStagePayloadV1,
} from '@/lib/dailyImportV1Contract';
import { normalizeCheckInCounterList } from '@/lib/checkinAllocation';
import { parseDailyImportRowsStrict } from '@/lib/dailyScheduleImport';
import {
  isDailyImportStaleVersionConflictV1,
  finishCommittedDailyImportV1,
  type DailyImportCommittedResultV1,
  stageDailyImportWithTerminalRetryV1,
  type DailyImportStageResultV1,
} from '@/lib/dailyImportRpcContract';
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
import DailyImportPreviewDialog from '@/app/(desktop)/components/DailyImportPreviewDialog';
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

const GRID_COLUMNS: Array<{ field: DailyGridField; label: string; numeric?: boolean; className?: string }> = [
  { field: 'aircraft', label: 'A/C Type', className: 'min-w-[92px]' },
  { field: 'arrFlight', label: 'Arr Flight', className: 'min-w-[112px]' },
  { field: 'sta', label: 'STA', className: 'min-w-[82px]' },
  { field: 'mcat', label: 'MCAT', className: 'min-w-[82px]' },
  { field: 'from', label: 'From', className: 'min-w-[90px]' },
  { field: 'arrPax', label: 'ARR PAX', numeric: true, className: 'min-w-[88px]' },
  { field: 'carousel', label: 'Carousel', numeric: true, className: 'min-w-[96px]' },
  { field: 'arrStand', label: 'Arr Stand', className: 'min-w-[92px]' },
  { field: 'arrCodeShare', label: 'Arr Code Share', className: 'min-w-[132px]' },
  { field: 'depFlight', label: 'Dep Flight', className: 'min-w-[112px]' },
  { field: 'std', label: 'STD', className: 'min-w-[82px]' },
  { field: 'mcdt', label: 'MCDT', className: 'min-w-[82px]' },
  { field: 'to', label: 'To', className: 'min-w-[90px]' },
  { field: 'depPax', label: 'DEP PAX', numeric: true, className: 'min-w-[88px]' },
  { field: 'gate', label: 'Gate', numeric: true, className: 'min-w-[78px]' },
  { field: 'counters', label: 'Counters', className: 'min-w-[116px]' },
];

const NUMERIC_FILTER_FIELDS = new Set<DailyGridField>(['arrPax', 'carousel', 'depPax', 'gate']);
const DAILY_IMPORT_V1_STAGE_ENABLED = process.env.NEXT_PUBLIC_DAILY_IMPORT_V1_STAGE_ENABLED !== 'false';

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
  if (isSelected) return 'Selected';
  if (row.arr && row.dep) return row.arr.linkedRecordId === row.dep.id ? 'Linked' : 'Paired';
  return row.arr ? 'ARR' : 'DEP';
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
      setError((err as Error).message);
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
  const operationalWritePending = useOperationalScheduleStore((state) => state.mutating || state.importing);
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
    buildLoadProgress('Loading daily schedule...', 10, 'Preparing workspace')
  );
  const [dailyImporting, setDailyImportingState] = useState(false);
  const setDailyImporting = useCallback((value: boolean) => {
    if (isOperationalScheduleV1Enabled()) useOperationalScheduleStore.setState({ importing: value });
    setDailyImportingState(value);
  }, []);
  const [dailyImportCommitting, setDailyImportCommitting] = useState(false);
  const [pendingImportRefresh, setPendingImportRefresh] = useSessionState<DailyImportCommittedResultV1 | null>('daily:committed-import-refresh', null);
  const [dailyImportPreview, setDailyImportPreview] = useState<{
    payload: DailyImportStagePayloadV1;
    result: DailyImportStageResultV1;
  } | null>(null);
  const [dailyImportPreviewV2, setDailyImportPreviewV2] = useSessionState<DailyImportStageResultV2 | null>('daily:operational-import-preview', null);
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
    reason: 'Importing daily file',
    beforeSync: waitForDailyLocalCommit,
  });
  useSeasonSyncGuard(season?.id ?? targetSeasonId, 'daily-hydration', {
    blocked: loading,
    reason: 'Loading server snapshot',
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
          setLoadProgress(buildLoadProgress('Loading operational window', 40, `${startDate}..${endDate}`));
          await refreshDailyWindow();
          if (cancelled) return;
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          setLoading(false);
          return;
        } catch (err) {
          console.error('Error loading operational daily schedule', err);
          if (!cancelled) {
            const message = err instanceof Error && err.message ? err.message : 'Could not load operational schedule.';
            setLoadError(message);
            void showAlert({ title: 'Load Failed', message, tone: 'error' });
          }
          return;
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      if (cachedState === 'fresh') return;
      setLoading(cachedState !== 'stale');
      setLoadError(null);
      setLoadProgress(buildLoadProgress('Loading seasons and settings', 15, 'Preparing daily schedule'));
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

        setLoadProgress(buildLoadProgress('Loading server workspace', 35, targetSeason.seasonCode));
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
            'Preparing Daily Schedule',
            80,
            `${serverWindow.records.length} records`
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

        throw new Error('Server daily schedule window is unavailable.');
      } catch (err) {
        console.error('Error loading daily schedule', err);
        if (!cancelled) {
          const message = err instanceof Error && err.message ? err.message : 'Could not load daily schedule data from the server.';
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
      void showAlert({ title: 'Nothing to Export', message: 'No visible Daily Schedule rows match the current date range and filters.', tone: 'warning' });
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
      void showAlert({ title: 'Daily Export Failed', message: (err as Error).message, tone: 'error' });
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
  const dailyImportDisabled = isOperationalScheduleV1Enabled()
    ? loading || operationalWritePending || operationalMutating
    : !DAILY_IMPORT_V1_STAGE_ENABLED || syncWriteInProgress || dailyImporting || syncPendingCount > 0;
  const hasDailyImportTargetDraft = dailyImportPreview?.payload.seasons.some((target) => (
    (useSeasonWorkspaceStore.getState().workspaces[target.seasonId]?.syncMeta?.pendingCount ?? 0) > 0
  )) ?? false;
  const dailyImportCommitEnabled = !syncWriteInProgress
    && syncPendingCount === 0
    && !hasDailyImportTargetDraft;
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
      if (pending.mutating || pending.importing) throw new Error('Wait for the pending operational write.');
      const canonicalRecord = flightRecords.find((record) => record.id === recordId);
      if (!canonicalRecord) throw new Error(`Daily record ${recordId} was not found`);
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
        if (!record) throw new Error(`Daily record ${legId} was not found`);
        if (updates.counter !== undefined) updates.counter = normalizeCheckInCounterList(updates.counter);
        const patch = buildOperationalLegPatchAndPreimage(record, updates);
        return patch ? [patch] : [];
      });
      setOperationalMutating(true);
      try {
        const res = await useOperationalScheduleStore.getState().applyMutations(patches);
        operationalSnapshotRef.current = useOperationalScheduleStore.getState().snapshot;
        if (res.refreshError) {
          await showAlert({ title: 'Saved; refresh failed', message: res.refreshError, tone: 'error' });
        } else {
          setFlightRecords(useOperationalScheduleStore.getState().records);
        }
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season) throw new Error('No season selected for daily edit');
    const seasonId = season.id;
    await enqueueLocalMutation(async () => {
      const canonicalRecord = flightRecords.find((record) => record.id === recordId);
      if (!canonicalRecord) throw new Error(`Daily record ${recordId} was not found`);

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
    let staged;
    try {
      staged = await stageDailyScheduleImportV2(payload);
    } catch (error) {
      staged = await getDailyScheduleImportV2Status(payload.requestId).catch(() => { throw error; });
    }
    setDailyImportPreviewV2(staged);
  }, [setDailyImportPreviewV2]);

  const handleDailyImportFile = useCallback(async (file: File | null) => {
    if (!file || dailyImporting || (isOperationalScheduleV1Enabled() ? (operationalWritePending || useOperationalScheduleStore.getState().importing) : (!DAILY_IMPORT_V1_STAGE_ENABLED || syncWriteInProgress || syncPendingCount > 0))) return;
    if (isOperationalScheduleV1Enabled()) {
      setDailyImporting(true);
      try {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
        const analysis = analyzeDailyScheduleWorkbook(workbook);
        if (!analysis.selected) throw new Error(analysis.diagnostics.map((item) => item.message).join(' '));
        const selectedSheet = analysis.selected;
        const strict = parseDailyImportRowsStrict(selectedSheet.rows, { workbookProfile: selectedSheet.profile });
        const blocking = strict.diagnostics.filter((item) => item.severity === 'blocking');
        if (blocking.length) throw new Error(blocking.map((item) => item.message).join('\n'));
        const v2Legs: DailyImportLegInputV2[] = strict.legs.map((leg) => {
          const row = selectedSheet.rows[leg.rowNumber - 1] ?? {};
          return {
            operationalDate: leg.operationalDate,
            scheduledDate: leg.scheduledDate,
            scheduledTime: leg.scheduledTime,
            side: leg.side,
            airline: leg.airline,
            flightNumber: leg.flightNumber,
            rawFlightNumber: leg.rawFlightNumber,
            route: String(leg.updates.route ?? ''),
            aircraft: leg.aircraft,
            category: leg.category,
            flightType: leg.flightType,
            requestStatusCode: leg.requestStatusCode,
            sheetName: selectedSheet.sheetName,
            sourceRowNumber: leg.rowNumber,
            resources: leg.updates,
            rawResourceTokens: {
              stand: row[`${leg.side}Stand`] ? String(row[`${leg.side}Stand`]).trim() : null,
              gate: leg.side === 'DEP' && row.DEPGate ? String(row.DEPGate).trim() : null,
              carousel: leg.side === 'ARR' && row.ARRReclaimBelt ? String(row.ARRReclaimBelt).trim() : null,
              counter: leg.side === 'DEP' && row.CheckInDesk ? String(row.CheckInDesk).trim() : null,
            },
          };
        });
        const affectedDates = [...new Set(strict.coverage.map((entry) => entry.operationalDate))].sort();
        if (affectedDates.length === 0) affectedDates.push(fromDateTime.slice(0, 10));
        const legDates = new Set(strict.legs.map((leg) => leg.operationalDate));
        const confirmedZeroFlightDates = affectedDates.filter((date) => !legDates.has(date));
        if (confirmedZeroFlightDates.length > 0) {
          const confirmed = await showConfirm({
            title: 'Confirm zero flights',
            message: `Replace all operational flights on ${confirmedZeroFlightDates.join(', ')} with an empty schedule? The import affects only ${affectedDates.join(', ')}.`,
            tone: 'warning',
          });
          if (!confirmed) return;
        }
        const rawChecksum = await sha256Hex(buffer);
        const canonicalChecksum = await sha256Hex(JSON.stringify(v2Legs));
        const payloadV2: DailyImportStagePayloadV2 = {
          contractVersion: 2,
          requestId: crypto.randomUUID(),
          fileName: file.name,
          workbookProfile: selectedSheet.profile,
          rawChecksum,
          canonicalChecksum,
          resourcePolicyHash: await sha256Hex(DAILY_RESOURCE_POLICY_VERSION),
          affectedDates,
          confirmedZeroFlightDates,
          legs: v2Legs,
          diagnostics: strict.diagnostics.map((item) => ({ ...item, sheetName: selectedSheet.sheetName })),
        };
        await stageOperationalImport(payloadV2);
      } catch (err) {
        void showAlert({ title: 'Daily Import V2 Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        setDailyImporting(false);
        if (dailyImportInputRef.current) dailyImportInputRef.current.value = '';
      }
      return;
    }
    setDailyImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      const analysis = analyzeDailyScheduleWorkbook(workbook);
      if (!analysis.selected) throw new Error(analysis.diagnostics.map((item) => item.message).join(' '));
      const selectedSheet = analysis.selected;
      const stageWithSeasonMetadata = async (seasonMetadata: Season[]) => {
        const payload = await buildDailyImportStagePayloadV1({
          fileName: file.name,
          rawBuffer: buffer,
          sheet: selectedSheet,
          seasons: seasonMetadata,
        });
        const pendingTarget = payload.seasons.find((target) => (
          (useSeasonWorkspaceStore.getState().workspaces[target.seasonId]?.syncMeta?.pendingCount ?? 0) > 0
        ));
        if (pendingTarget) {
          throw new Error(`Season ${pendingTarget.seasonCode} đang có draft/pending changes; hãy Save hoặc xử lý draft trước khi stage Daily import.`);
        }
        return stageDailyImportWithTerminalRetryV1(payload, stageDailyScheduleImportV1, {
          getStatus: getDailyScheduleImportV1Status,
        });
      };

      try {
        setDailyImportPreview(await stageWithSeasonMetadata(seasons));
      } catch (stageError) {
        if (!isDailyImportStaleVersionConflictV1(stageError)) throw stageError;
        const refreshedSeasons = await getSeasons();
        setCachedSeasons(refreshedSeasons);
        setSeasons(refreshedSeasons);
        useSeasonWorkspaceStore.getState().setSeasons(refreshedSeasons);
        const refreshedSeason = season
          ? refreshedSeasons.find((item) => item.id === season.id) ?? null
          : null;
        if (refreshedSeason) setSeason(refreshedSeason);
        setDailyImportPreview(await stageWithSeasonMetadata(refreshedSeasons));
      }
    } catch (err) {
      void showAlert({ title: 'Daily Import Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setDailyImporting(false);
      if (dailyImportInputRef.current) dailyImportInputRef.current.value = '';
    }
  }, [dailyImporting, fromDateTime, operationalWritePending, season, seasons, setDailyImporting, showAlert, showConfirm, stageOperationalImport, syncPendingCount, syncWriteInProgress]);

  const closeDailyImportPreview = useCallback(async () => {
    const current = dailyImportPreview;
    setDailyImportPreview(null);
    if (current && current.result.status !== 'committed') {
      try { await cancelDailyScheduleImportV1(current.result.batchId); } catch { /* Expiry/cancel recovery is server-authoritative. */ }
    }
  }, [dailyImportPreview]);

  const confirmDailyZeroFlightDates = useCallback(async (datesBySeasonId: Record<string, string[]>) => {
    if (!dailyImportPreview || dailyImporting) return;
    setDailyImporting(true);
    try {
      const payload = await confirmDailyImportZeroFlightDatesV1(dailyImportPreview.payload, datesBySeasonId);
      await cancelDailyScheduleImportV1(dailyImportPreview.result.batchId);
      const result = await stageDailyScheduleImportV1(payload);
      setDailyImportPreview({ payload, result });
    } catch (error) {
      void showAlert({ title: 'Zero-flight Confirmation Failed', message: (error as Error).message, tone: 'error' });
    } finally {
      setDailyImporting(false);
    }
  }, [dailyImportPreview, dailyImporting, setDailyImporting, showAlert]);

  const applyCommittedDailyImport = useCallback(async (receipt: NonNullable<DailyImportStageResultV1['result']>) => {
    setDailyImportPreview(null);
    setSelectedRowIds(new Set());
    const committedVersions = new Map(receipt.seasons.map((item) => [item.seasonId, item.dataVersion]));
    const nextSeasons = seasons.map((item) => {
      const dataVersion = committedVersions.get(item.id);
      const currentVersion = useSeasonWorkspaceStore.getState().seasons.find((entry) => entry.id === item.id)?.dataVersion ?? 0;
      return dataVersion === undefined ? item : { ...item, dataVersion: Math.max(item.dataVersion ?? 0, currentVersion, dataVersion) };
    });
    setCachedSeasons(nextSeasons);
    setSeasons(nextSeasons);
    useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);
    for (const item of receipt.seasons) {
      patchCachedSeasonData(item.seasonId, { seasonDataVersion: nextSeasons.find((entry) => entry.id === item.seasonId)?.dataVersion ?? item.dataVersion });
    }
    const committedSeason = season
      ? nextSeasons.find((item) => item.id === season.id) ?? season
      : null;
    if (committedSeason && committedVersions.has(committedSeason.id)) {
      setSeason(committedSeason);
      const windowKey = buildDailyWindowKey(fromDateTime, toDateTime);
      const serverWindow = await revalidateSeasonWorkspaceWindow({
        seasonId: committedSeason.id,
        dateFrom: fromDateTime.slice(0, 10),
        dateTo: toDateTime.slice(0, 10),
        resourceType: 'schedule',
        limit: 100000,
      }, {
        force: true,
        initiator: 'immediate',
      });
      if (!serverWindow?.syncMeta) throw new Error('Server chưa trả về workspace window sau commit.');
      if (serverWindow?.syncMeta) {
        loadedWindowKeyRef.current = windowKey;
        applyDailyNativeState(committedSeason.id, serverWindow.records, serverWindow.modifications, serverWindow.syncMeta, {
          replaceWindow: true,
          season: committedSeason,
          windowKey,
        });
      }
    }
  }, [applyDailyNativeState, fromDateTime, season, seasons, toDateTime]);

  const refreshCommittedDailyImport = useCallback(async (receipt: DailyImportCommittedResultV1) => {
    const remember = (value: DailyImportCommittedResultV1 | null) => {
      setPendingImportRefresh(value);
      // Persist before awaiting the network. Logout clears app session storage.
      try { sessionStorage.setItem('daily:committed-import-refresh', JSON.stringify(value)); } catch { /* Keep the in-memory receipt if storage is unavailable. */ }
    };
    const outcome = await finishCommittedDailyImportV1(receipt, {
      remember,
      refresh: applyCommittedDailyImport,
      clear: () => remember(null),
    });
    if (outcome.refreshError) {
      void showAlert({ title: 'Daily Import Committed — Refresh Pending', message: `Batch ${receipt.batchId} đã commit. Chưa tải lại được lịch: ${outcome.refreshError}. Bấm tải lại dữ liệu; không cần import lại.`, tone: 'warning' });
    }
    return outcome;
  }, [applyCommittedDailyImport, setPendingImportRefresh, showAlert]);

  const retryCommittedDailyRefresh = useCallback(async () => {
    if (!pendingImportRefresh || dailyImportCommitting) return;
    setDailyImportCommitting(true);
    try { await refreshCommittedDailyImport(pendingImportRefresh); }
    finally { setDailyImportCommitting(false); }
  }, [dailyImportCommitting, pendingImportRefresh, refreshCommittedDailyImport]);
  const handleRetryPendingMutation = useCallback(async () => {
    setOperationalMutating(true);
    try {
      const outcome = await useOperationalScheduleStore.getState().retryPendingMutation();
      if (outcome && 'refreshError' in outcome && outcome.refreshError) {
        void showAlert({ title: 'Saved; refresh failed', message: outcome.refreshError, tone: 'warning' });
      } else {
        await refreshDailyWindow({ revalidate: true });
      }
    } catch (err) {
      void showAlert({ title: 'Retry Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      const remaining = useOperationalScheduleStore.getState().unresolvedAttempt;
      if (!remaining) {
        setOperationalMutating(false);
      }
    }
  }, [refreshDailyWindow, setOperationalMutating, showAlert]);


  const commitDailyImportPreview = useCallback(async () => {
    if (!dailyImportPreview || dailyImportCommitting) return;
    setDailyImportCommitting(true);
    try {
      const pendingTarget = dailyImportPreview.payload.seasons.find((target) => (
        (useSeasonWorkspaceStore.getState().workspaces[target.seasonId]?.syncMeta?.pendingCount ?? 0) > 0
      ));
      if (syncPendingCount > 0 || pendingTarget) {
        throw new Error('Daily import commit bị chặn vì target season đang có draft/pending changes.');
      }
      const expectedVersions = Object.fromEntries(dailyImportPreview.payload.seasons.map((target) => [target.seasonId, target.expectedDataVersion]));
      let receipt;
      try {
        receipt = await commitDailyScheduleImportV1({ batchId: dailyImportPreview.result.batchId, expectedVersions, previewHash: dailyImportPreview.result.previewHash });
      } catch (commitError) {
        const recovered = await getDailyScheduleImportV1Status(dailyImportPreview.payload.requestId).catch(() => null);
        if (recovered?.status !== 'committed' || !recovered.result) throw commitError;
        receipt = recovered.result;
      }
      const outcome = await refreshCommittedDailyImport(receipt);
      if (!outcome.refreshError) void showAlert({ title: 'Daily Import Complete', message: `Committed atomic batch ${receipt.batchId} for ${receipt.seasons.length} season(s).`, tone: 'success' });
    } catch (error) {
      void showAlert({ title: 'Daily Import Commit Failed', message: (error as Error).message, tone: 'error' });
    } finally {
      setDailyImportCommitting(false);
    }
  }, [refreshCommittedDailyImport, dailyImportCommitting, dailyImportPreview, showAlert, syncPendingCount]);

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
          void showAlert({ title: 'Flights created — refresh pending', message: outcome.refreshError, tone: 'warning' });
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
      void showAlert({ title: 'Add Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, setOperationalMutating, showAlert, syncWriteInProgress]);

  const handleDeleteSelected = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      if (selectedRecordIds.length === 0) return;
      const shouldDelete = await showConfirm({
        title: 'Delete Selected Flights',
        message: `Delete ${selectedRecordIds.length} selected flight occurrence(s)?`,
        tone: 'warning',
        confirmLabel: 'Delete',
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
        void showAlert({ title: 'Delete Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress || selectedRecordIds.length === 0) return;
    const shouldDelete = await showConfirm({
      title: 'Delete Selected Flights',
      message: `Delete ${selectedRecordIds.length} selected flight occurrence(s)?`,
      tone: 'warning',
      confirmLabel: 'Delete',
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
      void showAlert({ title: 'Delete Failed', message: (err as Error).message, tone: 'error' });
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
          throw new Error('Linking requires equal nonzero ARR and DEP selections.');
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
        void showAlert({ title: 'Link Failed', message: (err as Error).message, tone: 'error' });
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
          throw new Error('Linking requires equal nonzero ARR and DEP selections.');
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
      void showAlert({ title: 'Link Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, refreshDailyWindow, season, selectedRecordIds, setOperationalMutating, showAlert, syncWriteInProgress]);

  const handleUnlinkSelected = useCallback(async () => {
    if (isOperationalScheduleV1Enabled()) {
      if (selectedRecordIds.length === 0) return;
      const shouldUnlink = await showConfirm({
        title: 'Unlink Selected Flights',
        message: `Unlink ${selectedRecordIds.length} selected flight occurrence(s)?`,
        tone: 'warning',
        confirmLabel: 'Unlink',
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
        void showAlert({ title: 'Unlink Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        setOperationalMutating(false);
      }
      return;
    }
    if (!season || syncWriteInProgress || selectedRecordIds.length === 0) return;
    const shouldUnlink = await showConfirm({
      title: 'Unlink Selected Flights',
      message: `Unlink ${selectedRecordIds.length} selected flight occurrence(s)?`,
      tone: 'warning',
      confirmLabel: 'Unlink',
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
      void showAlert({ title: 'Unlink Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, refreshDailyWindow, season, selectedRecordIds, setOperationalMutating, showAlert, showConfirm, syncWriteInProgress]);

  const handleSync = useCallback(async () => {
    if (!season || syncInProgress) return;
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Save Failed', message: result.message ?? 'Save failed.', tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
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
    setLoadProgress(buildLoadProgress('Loading server workspace', 35, season.seasonCode));
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
      if (!serverWindow?.syncMeta) throw new Error('Server daily schedule window is unavailable.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== windowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = windowKey;
      setLoadProgress(buildLoadProgress('Preparing Daily Schedule', 80, `${serverWindow.records.length} records`));
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
      const message = err instanceof Error && err.message ? err.message : 'Could not fetch daily schedule data from the server.';
      if (!hasRouteDataLoaded) setLoadError(message);
      void showAlert({ title: 'Fetch data failed', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [applyDailyNativeState, fetchingServerData, fromDateTime, refreshDailyWindow, season, showAlert, syncInProgress, toDateTime]);

  return (
    <div className="flex h-dvh bg-surface text-on-surface overflow-hidden font-sans">
      <div className="flex-1 flex flex-col min-w-0 bg-surface h-dvh overflow-hidden">
        <header className="flex-none flex items-center justify-between px-6 py-3 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm z-30">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Daily Schedule</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {isOperationalScheduleV1Enabled() ? 'Operational Turns' : (season ? buildSeasonDisplayLabel(season) : 'No season selected')}
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
                  <option value="">No seasons</option>
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
                Có thao tác operational chưa xác nhận trên server (Yêu cầu {operationalUnresolvedAttempt.requestId.slice(0, 8)}…). Các thao tác khác đang bị tạm khóa.
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
        {pendingImportRefresh && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant bg-surface-container-high px-6 py-3 text-sm">
            <p className="text-pretty">Batch {pendingImportRefresh.batchId} đã commit. Dữ liệu hiển thị chưa được tải lại.</p>
            <button type="button" disabled={dailyImportCommitting || dailyImporting} onClick={() => void retryCommittedDailyRefresh()} className="rounded border border-primary px-3 py-2 font-semibold text-primary disabled:opacity-50">
              {dailyImportCommitting ? 'Đang tải lại…' : 'Tải lại dữ liệu đã commit'}
            </button>
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-hidden p-4 flex flex-col gap-3">
          <section className="flex-none rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-surface-variant">
              <fieldset disabled={isOperationalScheduleV1Enabled() && operationalWritePending} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  From
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
                  To
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
                      Today
                    </button>
                    <button
                      onClick={() => {
                        const range = buildOperationalDateRange('tomorrow');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                      Tomorrow
                    </button>
                    <button
                      onClick={() => {
                        const range = buildOperationalDateRange('next7days');
                        setFromDateTime(`${range.startDate}T05:00`);
                        setToDateTime(`${shiftVietnamIsoDate(range.endDate, 1)}T05:00`);
                      }}
                      className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                      7 Days
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={handleToday} className="inline-flex items-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors">
                      <span className="material-symbols-outlined text-[16px]">today</span>
                      Today
                    </button>
                    {[1, 2, 7].map((days) => (
                      <button
                        key={days}
                        onClick={() => handleQuickRange(days)}
                        className="rounded-full border border-outline-variant px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
                      >
                        {days}D
                      </button>
                    ))}
                  </>
                )}
                <button
                  onClick={() => handleAllocationNavigation('/checkin')}
                  disabled={!isOperationalScheduleV1Enabled() && !season}
                  title="Open Check-in Allocation for current day range"
                  aria-label="Open Check-in Allocation for current day range"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">countertops</span>
                </button>
                <button
                  onClick={() => handleAllocationNavigation('/gate')}
                  disabled={!isOperationalScheduleV1Enabled() && !season}
                  title="Open Gate Allocation for current day range"
                  aria-label="Open Gate Allocation for current day range"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PbbIcon className="h-[19px] w-[19px]" />
                </button>
              </fieldset>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-primary-container px-3 py-1 text-xs font-bold text-on-primary-container">ARR {summary.arr}</span>
                <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">DEP {summary.dep}</span>
                <span className="rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container">TOTAL {summary.total}</span>
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
                  onClick={() => dailyImportInputRef.current?.click()}
                  disabled={dailyImportDisabled}
                  title={DAILY_IMPORT_V1_STAGE_ENABLED ? 'Import Daily Schedule (.xls or .xlsx)' : 'Daily Import V1 staging is disabled'}
                  aria-label="Import Daily Schedule file"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[19px] ${dailyImporting ? 'animate-spin' : ''}`}>
                    {dailyImporting ? 'sync' : 'upload_file'}
                  </span>
                </button>
                <button
                  onClick={() => void handleExportDailyExcel()}
                  disabled={(!isOperationalScheduleV1Enabled() && !season) || exportingExcel || sortedRows.length === 0}
                  title="Export visible Daily schedule to Excel"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded border border-outline-variant bg-surface-container px-3 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[18px] ${exportingExcel ? 'animate-spin' : ''}`}>
                    {exportingExcel ? 'sync' : 'download'}
                  </span>
                  Export Excel
                </button>
                <button
                  onClick={() => setIsNewFlightOpen(true)}
                  disabled={actionsDisabled}
                  title="Add flight"
                  aria-label="Add flight"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">add</span>
                </button>
                <button
                  onClick={() => void handleLinkSelected()}
                  disabled={actionsDisabled || !canLinkSelection}
                  title="Link selected flights"
                  aria-label="Link selected flights"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link</span>
                </button>
                <button
                  onClick={() => void handleUnlinkSelected()}
                  disabled={actionsDisabled || !canUnlinkSelection}
                  title="Unlink selected flights"
                  aria-label="Unlink selected flights"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link_off</span>
                </button>
                <button
                  onClick={() => void handleDeleteSelected()}
                  disabled={actionsDisabled || !hasSelectedRecords}
                  title="Delete selected flights"
                  aria-label="Delete selected flights"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-error/40 bg-surface-container text-error transition-colors hover:bg-error-container hover:text-on-error-container disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">delete</span>
                </button>
              </div>
              <input
                value={filters.query ?? ''}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                placeholder="Search flight, route, aircraft..."
                className="min-w-[280px] flex-1 bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
              />
              <select
                value={filters.type ?? 'all'}
                onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value as DailyFilterState['type'] }))}
                className="bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="arrivals">Arrivals</option>
                <option value="departures">Departures</option>
              </select>
            </div>
          </section>

          <section className="flex-1 min-h-0 rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm overflow-hidden">
            {loading ? (
              <LoadingStatusPanel progress={loadProgress} className="h-full min-h-[320px]" />
            ) : loadError ? (
              <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="font-body-sm text-body-sm font-semibold text-error">Cannot load daily schedule</div>
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
                <div>No season selected. Import an OperationalTurns file to create one.</div>
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
                          aria-label="Select visible rows"
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
                            placeholder={column.numeric ? 'Number' : 'Filter'}
                            className="mt-2 w-full rounded border border-outline-variant bg-surface-container-highest px-2 py-1 text-xs font-normal text-on-surface focus:outline-none focus:border-primary"
                          />
                        </th>
                      ))}
                      <th className="min-w-[96px] px-2 py-2 align-top font-label-caps text-label-caps text-on-surface-variant">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-variant font-data-tabular text-data-tabular text-on-surface">
                    {sortedRows.length === 0 ? (
                      <tr>
                        <td colSpan={GRID_COLUMNS.length + 2} className="px-4 py-10 text-center text-on-surface-variant">
                          No rows match the current daily filters.
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
                            aria-label={`Select ${row.arr?.flightNumber ?? row.dep?.flightNumber ?? 'daily row'}`}
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
      {dailyImportPreview && (
        <DailyImportPreviewDialog
          result={dailyImportPreview.result}
          commitEnabled={dailyImportCommitEnabled}
          committing={dailyImportCommitting}
          restaging={dailyImporting}
          onCancel={() => { void closeDailyImportPreview(); }}
          onCommit={() => { void commitDailyImportPreview(); }}
          onConfirmZeroFlightDates={(datesBySeasonId) => { void confirmDailyZeroFlightDates(datesBySeasonId); }}
        />
      )}
      {dailyImportPreviewV2 && (
        <DailyImportPreviewDialogV2
          result={dailyImportPreviewV2}
          commitEnabled={!operationalWritePending}
          committing={dailyImporting}
          onCancel={() => {
            if (useOperationalScheduleStore.getState().importing) return;
            const batchId = dailyImportPreviewV2.batchId;
            setDailyImportPreviewV2(null);
            if (dailyImportPreviewV2.status !== 'committed') {
              void cancelDailyScheduleImportV2(batchId).catch((error) => {
                void showAlert({ title: 'Cancel not confirmed', message: error.message, tone: 'warning' });
              });
            }
          }}
          onCommit={async () => {
            const pending = useOperationalScheduleStore.getState();
            if (pending.importing || pending.mutating || dailyImportPreviewV2.status !== 'validated') return;
            setDailyImporting(true);
            try {
              let receipt;
              try {
                const committed = await commitDailyScheduleImportV2({
                  batchId: dailyImportPreviewV2.batchId,
                  previewHash: dailyImportPreviewV2.previewHash,
                });
                if (committed.status !== 'committed' || !committed.result) throw new Error('Commit receipt is unavailable; check batch status before retrying.');
                receipt = committed.result;
              } catch (error) {
                const recovered = await getDailyScheduleImportV2Status(dailyImportPreviewV2.requestId).catch(() => null);
                if (recovered) setDailyImportPreviewV2(recovered);
                if (recovered?.status !== 'committed' || !recovered.result) throw error;
                receipt = recovered.result;
              }
              setDailyImportPreviewV2({ ...dailyImportPreviewV2, status: 'committed', result: receipt });
              useOperationalScheduleStore.setState({ snapshot: { revision: receipt.revision, token: '' } });
              setSelectedRowIds(new Set());
              try {
                await refreshDailyWindow({ revalidate: true });
              } catch (refreshError) {
                void showAlert({
                  title: 'Import committed — refresh pending',
                  message: `Batch ${receipt.batchId} was committed. Reload the window; do not import again. ${(refreshError as Error).message}`,
                  tone: 'warning',
                });
              }
            } catch (commitErr) {
              void showAlert({ title: 'Import V2 Commit Failed', message: (commitErr as Error).message, tone: 'error' });
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
              void showAlert({ title: 'Re-staging Failed', message: (err as Error).message, tone: 'error' });
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
        progress={buildLoadProgress('Loading daily schedule...', 20, 'Preparing route')}
        mode="fullscreen"
      />
    }>
      <DailyScheduleContent />
    </Suspense>
  );
}
