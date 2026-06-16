'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import {
  createSeason,
  findSeasonByCode,
  getOperationalSettings,
  getSeasons,
} from '@/lib/remoteStore';
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
  buildDailyCellModification,
  buildDailyScheduleRows,
  buildDailySummary,
  buildDefaultDailyDateRange,
  filterDailyRows,
  formatDailyScheduleDateTime,
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
  buildDailyScheduleImportUpdate,
  partitionDailyImportRowsByIataSeason,
  parseDailyImportWorksheet,
  type DailyImportSeasonBatch,
  type DailyScheduleImportStats,
} from '@/lib/dailyScheduleImport';
import { buildDailyScheduleExportFileName, buildDailyScheduleSummaryWorkbook } from '@/lib/dailyScheduleExport';
import { saveWorkbookAsXlsx } from '@/lib/exportSave';
import { buildDailyStandGateModifications } from '@/lib/gateAllocation';
import { getSeasonDateRange } from '@/lib/iataSeason';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  getCachedSeasons,
  patchCachedSeasonData,
  publishSeasonWorkspaceChanged,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { ensureNativeLocalSeason, queryNativeScheduleWindow, runNativeScheduleMutation } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';
import type { FlightCounter, FlightModification, FlightRecord, ModHistoryEntry, OperationalSettings, Season } from '@/lib/types';
import NewFlightModal from '../components/NewFlightModal';
import { useAppDialog } from '../components/AppDialog';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import { useCachedRouteSearchParams } from '../components/RouteCacheContext';
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
  { field: 'arrStand', label: 'Arr Stand', numeric: true, className: 'min-w-[92px]' },
  { field: 'arrCodeShare', label: 'Arr Code Share', className: 'min-w-[132px]' },
  { field: 'depFlight', label: 'Dep Flight', className: 'min-w-[112px]' },
  { field: 'std', label: 'STD', className: 'min-w-[82px]' },
  { field: 'mcdt', label: 'MCDT', className: 'min-w-[82px]' },
  { field: 'to', label: 'To', className: 'min-w-[90px]' },
  { field: 'depPax', label: 'DEP PAX', numeric: true, className: 'min-w-[88px]' },
  { field: 'gate', label: 'Gate', numeric: true, className: 'min-w-[78px]' },
  { field: 'counters', label: 'Counters', className: 'min-w-[116px]' },
];

const NUMERIC_FILTER_FIELDS = new Set<DailyGridField>(['arrPax', 'carousel', 'arrStand', 'depPax', 'gate']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDailyImportStats(): DailyScheduleImportStats {
  return {
    importedRows: 0,
    updated: 0,
    inserted: 0,
    deleted: 0,
    skipped: 0,
  };
}

function addDailyImportStats(target: DailyScheduleImportStats, next: DailyScheduleImportStats): DailyScheduleImportStats {
  return {
    importedRows: target.importedRows + next.importedRows,
    updated: target.updated + next.updated,
    inserted: target.inserted + next.inserted,
    deleted: target.deleted + next.deleted,
    skipped: target.skipped + next.skipped,
  };
}

function dailyImportDateRange(batch: DailyImportSeasonBatch): { from: string; to: string } {
  const dates = [...batch.operationalDates].sort();
  return {
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

function buildDailyWindowKey(fromDateTime: string, toDateTime: string): string {
  return `daily:${fromDateTime.slice(0, 10)}:${toDateTime.slice(0, 10)}`;
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
  const searchParams = useCachedRouteSearchParams();
  const { dialogNode, showAlert, showConfirm } = useAppDialog();
  const { notifyExportCompleted } = useExportNotifications();
  const targetSeasonId = searchParams.get('season');
  const requestedDailyDate = normalizeDailyDateParam(searchParams.get('date'));
  const defaultRange = useMemo(() => buildDefaultDailyDateRange(requestedDailyDate ?? todayIso()), [requestedDailyDate]);

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [season, setSeason] = useState<Season | null>(null);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>([]);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [settings, setSettings] = useState<OperationalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading daily schedule...', 10, 'Preparing workspace')
  );
  const [dailyImporting, setDailyImporting] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    lastLocalChangeAt: null,
  });
  const [fromDateTime, setFromDateTime] = useSessionState('daily:fromDateTime', defaultRange.from);
  const [toDateTime, setToDateTime] = useSessionState('daily:toDateTime', defaultRange.to);
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
  const dailyDeleteShortcutInFlightRef = useRef(false);
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow, fetchUpdatesNow } = useSeasonSync(syncSeasonId, 'daily');
  const syncInProgress = syncStatus.status === 'syncing';
  const syncing = syncInProgress && syncStatus.mode === 'manual';
  const fetchingUpdates = syncStatus.status === 'catching_up' && syncStatus.mode === 'manual';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' || syncStatus.status === 'conflict' ? syncStatus.message : null);
  const fetchProgress = fetchingUpdates ? syncStatus.progress ?? syncStatus.message : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount);

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

  const refreshDailyWindow = useCallback(async () => {
    if (!season?.id) return null;
    const result = await queryNativeScheduleWindow({
      seasonId: season.id,
      dateFrom: fromDateTime.slice(0, 10),
      dateTo: toDateTime.slice(0, 10),
      limit: 10000,
    });
    if (!result) throw new Error('Native daily schedule query is unavailable.');
    const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
    applyDailyNativeState(season.id, result.records, nextModifications, result.syncMeta, {
      replaceWindow: true,
      season,
    });
    return result;
  }, [applyDailyNativeState, fromDateTime, season, toDateTime]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'daily',
    onNativeRefresh: async () => {
      await refreshDailyWindow();
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
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
          setSeason(null);
          setFlightRecords([]);
          setModifications(new Map());
          setSyncSummary({ pendingCount: 0, lastLocalChangeAt: null });
          return;
        }

        const targetSeason = nextSeasons.find((item) => item.id === targetSeasonId) ?? nextSeasons[0];
        if (!targetSeasonId || targetSeasonId !== targetSeason.id) {
          router.replace(`/daily?season=${targetSeason.id}`);
          return;
        }

        setSeason(targetSeason);
        setLoadProgress(buildLoadProgress('Checking local season baseline', 30, targetSeason.seasonCode));
        await ensureNativeSeasonBaseline(targetSeason);
        if (cancelled) return;
        setLoadProgress(buildLoadProgress('Querying native SQLite', 45, targetSeason.seasonCode));
        const result = await queryNativeScheduleWindow({
          seasonId: targetSeason.id,
          dateFrom: fromDateTime.slice(0, 10),
          dateTo: toDateTime.slice(0, 10),
          limit: 10000,
        });
        if (cancelled) return;
        if (!result) throw new Error('Native daily schedule query is unavailable.');
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setLoadProgress(buildLoadProgress(
          'Preparing Daily Schedule',
          80,
          `${result.records.length} records`
        ));
        applyDailyNativeState(targetSeason.id, result.records, nextModifications, result.syncMeta, {
          replaceWindow: true,
          season: targetSeason,
        });
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
  }, [applyDailyNativeState, fromDateTime, router, showAlert, targetSeasonId, toDateTime]);

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
    if (!season) return;
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
      const fileName = buildDailyScheduleExportFileName(season.seasonCode, fromDateTime, toDateTime);
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
  const actionsDisabled = !season || syncing || dailyImporting;
  const dailyImportDisabled = syncInProgress || dailyImporting;
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

  const handleSeasonalNavigation = () => {
    if (season && typeof window !== 'undefined') {
      sessionStorage.setItem('activeSeasonId', season.id);
    }
    router.push('/seasonal');
  };

  const handleSettingsNavigation = () => {
    if (season && typeof window !== 'undefined') {
      sessionStorage.setItem('activeSeasonId', season.id);
      router.push(`/settings?season=${season.id}`);
      return;
    }
    router.push('/settings');
  };

  function handleAllocationNavigation(path: '/checkin' | '/gate') {
    if (!season) return;
    const params = new URLSearchParams();
    params.set('season', season.id);
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
    const start = new Date(`${fromDateTime}:00`);
    if (Number.isNaN(start.getTime())) return;
    start.setDate(start.getDate() + days);
    const nextTo = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}T${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    setToDateTime(nextTo);
  };

  const handleCellCommit = useCallback(async (recordId: string, field: DailyCellField, value: string) => {
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
      });
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
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, fromDateTime, modifications, publishDailyWorkspaceChange, season, settings, toDateTime]);

  const handleDailyImportFile = useCallback(async (file: File | null) => {
    if (!file || syncInProgress || dailyImporting) return;
    setDailyImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      const firstSheetName = workbook.SheetNames[0];
      const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
      if (!firstSheet) throw new Error('Import file does not contain a readable worksheet.');
      const importRows = parseDailyImportWorksheet(firstSheet);
      if (importRows.length === 0) {
        void showAlert({ title: 'Daily Import', message: 'Import file contains no operational rows.', tone: 'warning' });
        return;
      }
      const batches = partitionDailyImportRowsByIataSeason(importRows);
      if (batches.length === 0) {
        void showAlert({ title: 'Daily Import', message: 'Import file contains no importable flight legs.', tone: 'warning' });
        return;
      }

      let importStats = emptyDailyImportStats();
      let changed = false;
      let finalTargetSeason: Season | null = null;
      let nextSeasons = seasons;
      await enqueueLocalMutation(async () => {
        const seasonsByCode = new Map(nextSeasons.map((item) => [item.seasonCode.toUpperCase(), item]));
        for (const batch of batches) {
          const seasonCode = batch.seasonCode.toUpperCase();
          let targetSeason = seasonsByCode.get(seasonCode) ?? await findSeasonByCode(seasonCode);
          if (!targetSeason) {
            const range = getSeasonDateRange(seasonCode);
            const seasonFields: Omit<Season, 'id'> = {
              seasonCode,
              name: seasonCode,
              fileName: file.name,
              uploadedAt: Date.now(),
              effectiveStart: range.start,
              effectiveEnd: range.end,
              totalLegs: batch.legCount,
              totalSourceRows: 0,
              dataVersion: 0,
            };
            const createdId = await createSeason(seasonFields);
            targetSeason = { ...seasonFields, id: createdId };
            nextSeasons = [...nextSeasons, targetSeason];
            seasonsByCode.set(seasonCode, targetSeason);
          }
          if (!seasonsByCode.has(seasonCode)) {
            nextSeasons = [...nextSeasons, targetSeason];
            seasonsByCode.set(seasonCode, targetSeason);
          }
          const ensuredSyncMeta = await ensureNativeLocalSeason(targetSeason);
          if (!ensuredSyncMeta) throw new Error('Native local season bootstrap is unavailable.');

          const range = dailyImportDateRange(batch);
          const currentWindow = await queryNativeScheduleWindow({
            seasonId: targetSeason.id,
            dateFrom: range.from,
            dateTo: range.to,
            limit: 100000,
          });
          if (!currentWindow) throw new Error(`Native daily schedule query is unavailable for ${seasonCode}.`);
          const currentModifications = new Map(currentWindow.modifications.map((mod) => [mod.legId, mod]));
          const timestamp = Date.now();
          const maxRecordSourceIndex = Math.max(0, ...currentWindow.records.map((record) => record.sourceRowIndex ?? 0));
          const update = buildDailyScheduleImportUpdate({
            records: currentWindow.records,
            modifications: currentModifications,
            importRows: batch.rows,
            timestamp,
            historyId: `LOCAL_DAILY_IMPORT_${seasonCode}_${timestamp}_${++historySeqRef.current}`,
            nextSourceRowIndex: maxRecordSourceIndex + 1,
          });
          importStats = addDailyImportStats(importStats, update.stats);
          finalTargetSeason = targetSeason;
          if (!update.historyEntry) continue;

          const nativeSyncMeta = await runNativeScheduleMutation(
            targetSeason.id,
            update.historyEntry.recordChanges?.map((change) => change.newRecord).filter((record): record is FlightRecord => record != null) ?? [],
            [],
            update.historyEntry.changes.map((change) => change.newMod),
            {
              id: update.historyEntry.id,
              timestamp: update.historyEntry.timestamp,
              description: update.historyEntry.description,
            }
          );
          if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
          const affectedIds = [
            ...update.historyEntry.changes.map((change) => change.legId),
            ...(update.historyEntry.recordChanges?.map((change) => change.recordId) ?? []),
          ];
          if (targetSeason.id === season?.id) {
            applyDailyNativeState(targetSeason.id, update.records, update.modifications, nativeSyncMeta, {
              affectedIds,
              replaceWindow: true,
              season: targetSeason,
              windowKey: buildDailyWindowKey(range.from, range.to),
            });
          }
          publishDailyWorkspaceChange(targetSeason.id, nativeSyncMeta.localRevision, affectedIds, nativeSyncMeta);
          setSelectedRowIds(new Set());
          void appendAuditLogEntry(createFlightActionAuditFromHistory({
            season: targetSeason,
            module: 'daily',
            operation: update.historyEntry.description,
            beforeRecords: currentWindow.records,
            afterRecords: update.records,
            beforeModifications: currentModifications,
            afterModifications: update.modifications,
            targetRecordIds: affectedIds,
            metadata: { stats: update.stats, seasonCode },
          }));
          changed = true;
        }
      });

      if (nextSeasons !== seasons) {
        const refreshedSeasons = await getSeasons();
        nextSeasons = refreshedSeasons.length > 0 ? refreshedSeasons : nextSeasons;
        setSeasons(nextSeasons);
        setCachedSeasons(nextSeasons);
      }
      if (finalTargetSeason) {
        const routedSeason = nextSeasons.find((item) => item.id === finalTargetSeason?.id) ?? finalTargetSeason;
        router.push(`/daily?season=${routedSeason.id}`);
      }
      const stats = importStats;
      void showAlert({
        title: changed ? 'Daily Import Complete' : 'Daily Import',
        message: changed
          ? `Processed ${batches.length} season${batches.length === 1 ? '' : 's'}. Updated ${stats.updated}, inserted ${stats.inserted}, deleted ${stats.deleted}, skipped ${stats.skipped}. Use Save to push changes to the server.`
          : `No Daily Schedule changes found. Skipped ${stats.skipped}.`,
        tone: changed ? 'success' : 'info',
      });
    } catch (err) {
      void showAlert({ title: 'Daily Import Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setDailyImporting(false);
      if (dailyImportInputRef.current) dailyImportInputRef.current.value = '';
    }
  }, [applyDailyNativeState, dailyImporting, enqueueLocalMutation, publishDailyWorkspaceChange, router, season?.id, seasons, showAlert, syncInProgress]);

  const handleAddFlights = useCallback(async (mods: FlightModification[]) => {
    if (!season) return;
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
          }
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
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, showAlert]);

  const handleDeleteSelected = useCallback(async () => {
    if (!season || selectedRecordIds.length === 0) return;
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
        });
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
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, selectedRecordIds, showAlert, showConfirm]);

  useEffect(() => {
    if (!season) return undefined;
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
    if (!season || selectedRecordIds.length === 0) return;
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
            : undefined
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
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, selectedRecordIds, showAlert]);

  const handleUnlinkSelected = useCallback(async () => {
    if (!season || selectedRecordIds.length === 0) return;
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
            : undefined
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
  }, [applyDailyNativeState, enqueueLocalMutation, flightRecords, modifications, publishDailyWorkspaceChange, season, selectedRecordIds, showAlert, showConfirm]);

  const handleSync = useCallback(async () => {
    if (!season || syncInProgress) return;
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Save Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [season, showAlert, syncInProgress, syncNow]);

  const handleFetchUpdates = useCallback(async () => {
    if (!syncSeasonId || fetchingUpdates || syncInProgress) return;
    try {
      const result = await fetchUpdatesNow();
      if (result.status !== 'synced') {
        void showAlert({ title: 'Fetch Updates Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Fetch Updates Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [fetchUpdatesNow, fetchingUpdates, showAlert, syncInProgress, syncSeasonId]);

  return (
    <div className="flex h-screen bg-surface text-on-surface overflow-hidden font-sans">
      <div className="flex-1 flex flex-col min-w-0 bg-surface h-screen overflow-hidden">
        <header className="flex-none flex items-center justify-between px-6 py-3 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm z-30">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Daily Schedule</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">{season ? buildSeasonDisplayLabel(season) : 'No season selected'}</p>
          </div>
          <div className="flex items-center gap-3">
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
                <SeasonConflictReviewControl seasonId={season?.id} />
                <FetchServerUpdatesButton
                  fetching={fetchingUpdates}
                  progress={fetchProgress}
                  disabled={syncInProgress}
                  onFetch={handleFetchUpdates}
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

        <main className="flex-1 min-h-0 overflow-hidden p-4 flex flex-col gap-3">
          <section className="flex-none rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-surface-variant">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
                  From
                  <input
                    type="datetime-local"
                    value={fromDateTime}
                    onChange={(event) => setFromDateTime(event.target.value)}
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
                <button
                  onClick={() => handleAllocationNavigation('/checkin')}
                  disabled={!season}
                  title="Open Check-in Allocation for current day range"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">countertops</span>
                </button>
                <button
                  onClick={() => handleAllocationNavigation('/gate')}
                  disabled={!season}
                  title="Open Gate Allocation for current day range"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PbbIcon className="h-[19px] w-[19px]" />
                </button>
              </div>
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
                  title="Import OperationalTurns file"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[19px] ${dailyImporting ? 'animate-spin' : ''}`}>
                    {dailyImporting ? 'sync' : 'upload_file'}
                  </span>
                </button>
                <button
                  onClick={() => void handleExportDailyExcel()}
                  disabled={!season || exportingExcel || sortedRows.length === 0}
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
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">add</span>
                </button>
                <button
                  onClick={() => void handleLinkSelected()}
                  disabled={actionsDisabled || !canLinkSelection}
                  title="Link selected flights"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link</span>
                </button>
                <button
                  onClick={() => void handleUnlinkSelected()}
                  disabled={actionsDisabled || !canUnlinkSelection}
                  title="Unlink selected flights"
                  className="inline-flex h-9 w-9 items-center justify-center rounded border border-outline-variant bg-surface-container text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[19px]">link_off</span>
                </button>
                <button
                  onClick={() => void handleDeleteSelected()}
                  disabled={actionsDisabled || !hasSelectedRecords}
                  title="Delete selected flights"
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
                    fetching={fetchingUpdates}
                    progress={fetchProgress}
                    disabled={syncing}
                    onFetch={handleFetchUpdates}
                  />
                )}
              </div>
            ) : !season ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-on-surface-variant">
                <div>No season selected. Import an OperationalTurns file to create one.</div>
                {syncSeasonId && (
                  <FetchServerUpdatesButton
                    fetching={fetchingUpdates}
                    progress={fetchProgress}
                    disabled={syncing}
                    onFetch={handleFetchUpdates}
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
        onSubmitDetailed={(mods) => {
          void handleAddFlights(mods);
        }}
      />
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
