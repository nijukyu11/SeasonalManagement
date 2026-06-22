'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { parseSeasonalSchedule, enrichRows } from '@/lib/parser';
import {
  createSeason, getSeasons,
  findSeasonByCode, updateSeason,
  batchWriteFlightRecords, clearSourceRows, deleteModifications, getFlightRecords, getModifications,
  getSeasonEventHighWater, verifySeasonImportCounts,
} from '@/lib/remoteStore';
import { validateFlightLegsForSeasonalExport } from '@/lib/exporter';
import { buildCanonicalSeasonalRows, downloadCanonicalSeasonalExcel } from '@/lib/canonicalSeasonalRows';
import {
  buildFlightRecordHistoryEntry,
  countHistoryEntryLegs,
  revertFlightRecordHistoryList,
  revertModificationHistoryMap,
} from '@/lib/detailedScheduleState';
import {
  buildImportBatchProgress,
  buildImportProgress,
  buildLoadProgress,
  type ImportProgress,
  type LoadProgress,
} from '@/lib/importProgress';
import { buildSeasonDisplayLabel, buildSeasonNameFromFileName, getDirtyImportGuard } from '@/lib/importSeasonRules';
import { buildSeasonalImportPatch, type SeasonalImportPatchStats } from '@/lib/seasonalImportPatch';
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
  mergeDuplicateImportPeriods,
  mergeDuplicateImportRecords,
  unlinkFlightRecords,
  type DuplicateImportPeriod,
} from '@/lib/atomicSchedule';
import {
  buildSeasonalLinkCandidates,
  buildSeasonalLinkRoute,
  getSeasonalLinkActionState,
  type SeasonalLinkCandidate,
} from '@/lib/seasonalLinkActions';
import { buildSeasonalDisplayGroups } from '@/lib/seasonalDisplayAggregator';
import { matchesSeasonalFlightFilter } from '@/lib/seasonalFlightFilter';
import {
  createLocalWorkspace,
  getLocalSyncConflictCount,
  type LocalSyncMeta,
} from '@/lib/localSeasonStore';
import { appendAuditLogEntry, createFlightActionAuditFromHistory } from '@/lib/auditLog';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import type { Season, DisplayRow, FlightRecord, FlightLeg, FlightModification, ParsedRow, ModHistoryEntry } from '@/lib/types';
import { withScheduleNotificationPayload } from '@/lib/scheduleNotifications';
import { resolveLinkedDeletionTargets } from '@/lib/pairDeletion';
import { filterUiUndoEntriesForSession, trimUiUndoEntries } from '@/lib/uiUndoMemory';
import { useAppDialog } from './components/AppDialog';
import { useExportNotifications } from './components/ExportNotificationProvider';
import FetchServerUpdatesButton from './components/FetchServerUpdatesButton';
import SeasonConflictReviewControl from './components/SeasonConflictReviewControl';
import SyncActionButton from './components/SyncActionButton';
import NewFlightModal from './components/NewFlightModal';
import LoadingStatusPanel from './components/LoadingStatusPanel';
import WorkspacePageHeader from './components/WorkspacePageHeader';
import {
  getSeasonSyncLabel,
  getSeasonSyncPendingCount,
  getSeasonSyncTone,
  useSeasonSync,
  useSeasonSyncActions,
  useSeasonSyncGuard,
} from './components/SeasonSyncProvider';
import { useSeasonWorkspaceRefresh } from './hooks/useSeasonWorkspaceRefresh';
import {
  checkNativeSeasonIntegrity,
  importNativeSeasonSnapshot,
  queryNativeScheduleWindow,
  queryNativeSyncSummary,
  runNativeScheduleMutation,
} from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';

const PAGE_SIZE = 50;
const DAY_LABELS = ['1', '2', '3', '4', '5', '6', '7'];
const FULL_SEASON_EXPORT_LIMIT = 500000;

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

function formatDuplicateImportMessage(periods: DuplicateImportPeriod[]): string {
  const limit = 20;
  const lines = periods.slice(0, limit).map((period) => (
    `${period.flightNumber} ${period.side}: ${period.effective} to ${period.discontinue} ` +
    `(source rows ${period.rowIndexes.join(', ')}, ${period.duplicateDates} duplicate date${period.duplicateDates === 1 ? '' : 's'})`
  ));
  const extra = periods.length > limit ? `\n...and ${periods.length - limit} more duplicate period(s).` : '';
  return `Import completed. Duplicate overlapping periods were merged:\n${lines.join('\n')}${extra}`;
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
  const { dialogNode, showAlert, showConfirm, showChoice } = useAppDialog();
  const { notifyExportCompleted } = useExportNotifications();

  // Data
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [activeSeason, setActiveSeason] = useState<Season | null>(null);
  const [displayRows, setDisplayRows] = useState<DisplayRow[]>([]);
  const [flightRecords, setFlightRecords] = useState<FlightRecord[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [modHistory, setModHistory] = useState<ModHistoryEntry[]>([]);
  const [draftState, setDraftState] = useState<SeasonalScheduleDraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading seasons...', 10, 'Preparing seasonal schedule')
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isNewFlightOpen, setIsNewFlightOpen] = useState(false);
  const [linkModalGroupKey, setLinkModalGroupKey] = useState<string | null>(null);
  const [linkingCandidateKey, setLinkingCandidateKey] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<{ pendingCount: number; conflictCount: number; lastLocalChangeAt: number | null }>({
    pendingCount: 0,
    conflictCount: 0,
    lastLocalChangeAt: null,
  });
  const [isUndoOpen, setIsUndoOpen] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const { status: syncStatus, syncNow, fetchUpdatesNow } = useSeasonSync(activeSeason?.id, 'seasonal');
  const { syncNow: syncAnySeasonNow } = useSeasonSyncActions();
  const syncInProgress = syncStatus.status === 'syncing';
  const fetchingUpdates = syncStatus.status === 'catching_up';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' || syncStatus.status === 'conflict' ? syncStatus.message : null);
  const fetchProgress = fetchingUpdates ? syncStatus.progress ?? syncStatus.message : syncStatus.message;
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncSummary.pendingCount);
  const syncLabel = getSeasonSyncLabel(syncStatus, syncSummary.pendingCount, syncSummary.conflictCount);
  const syncTone = getSeasonSyncTone(syncStatus, syncSummary.pendingCount, syncSummary.conflictCount);
  const hasDraftChanges = (draftState?.records.length ?? 0) + (draftState?.modifications.length ?? 0) > 0;

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

  const applySeasonData = useCallback((rows: ParsedRow[], records: FlightRecord[], mods: Map<string, FlightModification>) => {
    setFlightRecords(records);
    setDisplayRows(enrichRows(rows));
    setModifications(mods);
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

  const loadSeasonRows = useCallback(async (season: Season, force = false) => {
    void force;
    setLoadProgress(buildLoadProgress('Checking local season baseline', 20, season.seasonCode));
    await ensureNativeSeasonBaseline(season);
    setLoadProgress(buildLoadProgress('Querying native SQLite', 35, season.seasonCode));
    const scheduleWindow = await queryNativeScheduleWindow({
      seasonId: season.id,
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      flightNumberFilter: debouncedFilters.flight || null,
      routeFilter: debouncedFilters.route || null,
      limit: 100000,
    });
    if (!scheduleWindow) throw new Error('Native seasonal schedule query is unavailable.');
    const records = scheduleWindow.records;
    const mods = new Map(scheduleWindow.modifications.map((mod) => [mod.legId, mod]));
    const rows = buildPatternRowsFromRecords(records, mods);
    const windowKey = buildSeasonalWindowKey({
      dateFrom: debouncedFilters.dateFrom || null,
      dateTo: debouncedFilters.dateTo || null,
      flight: debouncedFilters.flight || null,
      route: debouncedFilters.route || null,
    });
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
      syncMeta: scheduleWindow.syncMeta,
      windowKey,
    });
    setActiveSeason(season);
    applySeasonData(rows, records, mods);
    setModHistory([]);
    setDraftState(null);
    setSyncSummary({
      pendingCount: scheduleWindow.syncMeta.pendingCount,
      conflictCount: getLocalSyncConflictCount(scheduleWindow.syncMeta),
      lastLocalChangeAt: scheduleWindow.syncMeta.lastLocalChangeAt,
    });
  }, [applySeasonData, debouncedFilters.dateFrom, debouncedFilters.dateTo, debouncedFilters.flight, debouncedFilters.route]);

  useSeasonWorkspaceRefresh({
    seasonId: activeSeason?.id,
    policy: 'on-activation',
    source: 'seasonal',
    onNativeRefresh: () => activeSeason ? loadSeasonRows(activeSeason, true) : undefined,
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
  }, [loadSeasonRows]);

  const handleSeasonChange = useCallback(async (seasonId: string) => {
    const found = seasons.find(s => s.id === seasonId);
    if (!found) return;
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
  }, [loadSeasonRows, seasons]);

  const handleRetryLoad = useCallback(async () => {
    if (!activeSeason) return;
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
    setSelectedRecordIds((prev) => {
      const next = new Set(prev);
      const ids = Array.from(group.recordIds);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

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

  const filteredRecordIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of filteredGroups) ids.push(...group.recordIds);
    return Array.from(new Set(ids));
  }, [filteredGroups]);
  const allFilteredSelected = filteredRecordIds.length > 0 && filteredRecordIds.every((id) => selectedRecordIds.has(id));
  const hasPartialFilteredSelection = !allFilteredSelected && filteredRecordIds.some((id) => selectedRecordIds.has(id));
  const toggleAllFilteredSelection = useCallback(() => {
    setSelectedRecordIds((prev) => {
      const next = new Set(prev);
      for (const id of filteredRecordIds) {
        if (allFilteredSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [allFilteredSelected, filteredRecordIds]);

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
    if (!activeSeason || activeDisplayLegs.length === 0 || isExporting) return;
    try {
      if (selectedRecordIds.size === 0) {
        void showAlert({
          title: 'Select flights to export',
          message: 'Tick the flight rows you want to export. To export the full schedule, select all rows first.',
          tone: 'info',
        });
        return;
      }
      setIsExporting(true);
      const exportWindow = await queryNativeScheduleWindow({
        seasonId: activeSeason.id,
        dateFrom: null,
        dateTo: null,
        flightNumberFilter: null,
        routeFilter: null,
        limit: FULL_SEASON_EXPORT_LIMIT,
      });
      if (!exportWindow) throw new Error('Native seasonal schedule query is unavailable.');
      const exportRecords = exportWindow.records;
      const exportModifications = new Map(exportWindow.modifications.map((mod) => [mod.legId, mod]));
      const selectedIds = Array.from(selectedRecordIds);
      const canonicalExport = buildCanonicalSeasonalRows({
        records: exportRecords,
        modifications: exportModifications,
        selectedRecordIds: selectedIds,
      });
      const exportLegs = canonicalExport.effectiveLegs;
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
        void showAlert({
          title: 'Cannot Export',
          message: exportValidation.issues[0].message,
          tone: 'error',
        });
        return;
      }
      if (!canonicalExport.validation.valid) {
        void showAlert({
          title: 'Cannot Export',
          message: canonicalExport.validation.issues[0]?.message ?? 'Canonical seasonal export does not round-trip.',
          tone: 'error',
        });
        return;
      }
      const result = await downloadCanonicalSeasonalExcel(canonicalExport.rows, activeSeason.seasonCode);
      notifyExportCompleted(result);
    } catch (err) {
      void showAlert({ title: 'Export Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setIsExporting(false);
    }
  }, [activeDisplayLegs, activeSeason, isExporting, notifyExportCompleted, selectedRecordIds, showAlert]);

  const handleUndo = useCallback(async (targetEntry: ModHistoryEntry) => {
    if (!activeSeason || syncInProgress) return;
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
        }
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(nextRecords, nextMods);
      applySeasonData(nextRows, nextRecords, nextMods);
      setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession(historyToUndoFrom.slice(targetIdx + 1))));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, conflictCount: getLocalSyncConflictCount(nativeSyncMeta), lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
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
      setSelectedRecordIds((prev) => {
        const visibleIds = new Set(nextRecords.map((record) => record.id));
        return new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
      });
      setIsUndoOpen(false);
    } catch (err) {
      void showAlert({ title: 'Undo Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setIsUndoing(false);
    }
  }, [activeSeason, applySeasonData, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, syncInProgress]);

  const handleDiscardSeasonalDraft = useCallback(() => {
    if (!activeSeason || !draftState) return;
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
  }, [activeSeason, applySeasonData, draftState]);

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

    try {
      const nativeSyncMeta = await runNativeScheduleMutation(
        activeSeason.id,
        addedRecords,
        [],
        regularMods,
        historyEntry
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, conflictCount: getLocalSyncConflictCount(nativeSyncMeta), lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
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
    }
  }, [
    activeSeason,
    draftState,
    flightRecords,
    handleDiscardSeasonalDraft,
    modHistory,
    modifications,
    publishSeasonalWorkspaceChange,
    syncInProgress,
  ]);

  useSeasonSyncGuard(activeSeason?.id, 'seasonal', {
    blocked: uploading,
    reason: 'Importing seasonal file',
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

    try {
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
    }
  }, [activeDisplayLegs, activeSeason, displayRows, draftState, flightRecords, modifications, showAlert, showChoice, showConfirm, syncInProgress]);

  const handleUnlinkGroup = useCallback(async (group: DisplayGroup) => {
    if (!activeSeason || syncInProgress) return;
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

    try {
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
          : undefined
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(result.records, modifications);
      setFlightRecords(result.records);
      setDisplayRows(enrichRows(nextRows));
      if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, conflictCount: getLocalSyncConflictCount(nativeSyncMeta), lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
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
    }
  }, [activeSeason, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, showConfirm, syncInProgress]);

  const handleApplySeasonalLinkCandidate = useCallback(async (candidate: SeasonalLinkCandidate) => {
    if (!activeSeason || syncInProgress) return;

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
          : undefined
      );
      if (!nativeSyncMeta) throw new Error('Native schedule mutation is unavailable.');
      const nextRows = buildPatternRowsFromRecords(result.records, modifications);
      setFlightRecords(result.records);
      setDisplayRows(enrichRows(nextRows));
      if (historyEntry) setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])));
      setSyncSummary({ pendingCount: nativeSyncMeta.pendingCount, conflictCount: getLocalSyncConflictCount(nativeSyncMeta), lastLocalChangeAt: nativeSyncMeta.lastLocalChangeAt });
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
    }
  }, [activeSeason, flightRecords, modHistory, modifications, publishSeasonalWorkspaceChange, showAlert, syncInProgress]);

  const handleSync = useCallback(async () => {
    if (!activeSeason || syncInProgress) return;
    try {
      const result = await syncNow();
      const needsReview = result.status === 'conflict' || (result.reviewCount ?? 0) > 0;
      void showAlert({
        title: needsReview ? 'Save Needs Review' : result.status === 'synced' ? 'Save Complete' : 'Save Failed',
        message: result.message ?? 'No pending local changes to save.',
        tone: needsReview ? 'warning' : result.status === 'synced' ? 'success' : 'error',
      });
    } catch (err) {
      void showAlert({ title: 'Save Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [activeSeason, showAlert, syncInProgress, syncNow]);

  const handleFetchUpdates = useCallback(async () => {
    if (!activeSeason || fetchingUpdates || syncInProgress) return;
    try {
      const result = await fetchUpdatesNow();
      if (result.status === 'busy') return;
      if (result.status === 'conflict') {
        void showAlert({ title: 'Fetch Updates Need Review', message: result.message, tone: 'warning' });
      } else if (result.status !== 'synced') {
        void showAlert({ title: 'Fetch Updates Failed', message: result.message, tone: 'error' });
      }
    } catch (err) {
      void showAlert({ title: 'Fetch Updates Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [activeSeason, fetchUpdatesNow, fetchingUpdates, showAlert, syncInProgress]);

  // Import handler
  const handleFile = useCallback(async (file: File) => {
    if (uploading || fetchingUpdates || syncInProgress) return;
    setUploading(true);
    try {
      setUploadProgress(buildImportProgress('Parsing file', 5));
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const { seasonCode, rows: parsedRows } = parseSeasonalSchedule(workbook);

      if (parsedRows.length === 0) {
        void showAlert({ title: 'Import Failed', message: 'File contains no valid data.', tone: 'warning' });
        return;
      }

      setUploadProgress(buildImportProgress('Calculating flight schedule', 18, `${parsedRows.length} source rows`));
      const duplicateMerge = mergeDuplicateImportPeriods(parsedRows);
      const rows = duplicateMerge.rows;
      const recordDuplicateMerge = mergeDuplicateImportRecords(flattenRowsToFlightRecords(rows));
      const duplicatePeriods = [
        ...duplicateMerge.duplicatePeriods,
        ...recordDuplicateMerge.duplicatePeriods,
      ];
      const importedRecords = recordDuplicateMerge.records;
      assertNoDuplicateFlightNumbers(importedRecords);

      setUploadProgress(buildImportProgress('Checking local changes', 24));
      const existing = await findSeasonByCode(seasonCode);
      if (existing) {
        const targetSummary = await queryNativeSyncSummary(existing.id);
        const dirtyGuard = getDirtyImportGuard({
          targetSeasonId: existing.id,
          targetSeasonCode: seasonCode,
          activeSeasonId: activeSeason?.id ?? null,
          pendingCount: targetSummary?.pendingCount ?? 0,
          conflictCount: targetSummary?.conflictCount ?? 0,
        });

        if (dirtyGuard.shouldBlock) {
          const choice = await showChoice({
            title: 'Unsynced Changes',
            message: `${dirtyGuard.message}\n\nChoose how to continue.`,
            tone: 'warning',
            choices: [
              { value: 'cancel', label: 'Cancel' },
              { value: 'discard', label: 'Discard local changes and re-import', tone: 'warning' },
              { value: 'sync', label: 'Sync first', tone: 'info' },
            ],
          });

          if (choice === 'cancel' || choice == null) return;
          if (choice === 'sync') {
            const result = await syncAnySeasonNow(existing.id, 'seasonal');
            if (result.status !== 'synced') {
              void showAlert({
                title: 'Import Blocked',
                message: result.message,
                tone: result.status === 'conflict' ? 'warning' : 'error',
              });
              return;
            }
            if (activeSeason?.id === existing.id) {
              await loadSeasonRows(activeSeason, true);
            }
          }
        }
      }

      let seasonId: string;
      const uploadedAt = Date.now();
      let seasonRecords = importedRecords;
      let seasonMods = new Map<string, FlightModification>();
      let recordsToWrite = importedRecords;
      let affectedRecordIds = importedRecords.map((record) => record.id);
      let modificationDeleteRecordIds = importedRecords.map((record) => record.id);
      let patchStats: SeasonalImportPatchStats = {
        imported: importedRecords.length,
        added: importedRecords.length,
        updated: 0,
        deleted: 0,
        unchanged: 0,
        affected: importedRecords.length,
      };

      if (existing) {
        setUploadProgress(buildImportProgress(`Loading current ${seasonCode} baseline`, 28));
        const [currentRecords, currentMods] = await Promise.all([
          getFlightRecords(existing.id),
          getModifications(existing.id),
        ]);
        const patch = buildSeasonalImportPatch({
          existingRecords: currentRecords,
          existingModifications: currentMods,
          importedRows: rows,
          importedRecords,
        });
        seasonRecords = patch.mergedRecords;
        seasonMods = patch.remainingModifications;
        recordsToWrite = patch.recordsToWrite;
        affectedRecordIds = patch.affectedRecordIds;
        modificationDeleteRecordIds = patch.modificationDeleteRecordIds;
        patchStats = patch.stats;
      }

      const legs = flightRecordsToLegs(seasonRecords);
      const dates = legs.map((l) => l.date).sort();
      const seasonFields = {
        seasonCode,
        name: buildSeasonNameFromFileName(file.name, seasonCode),
        fileName: file.name,
        uploadedAt,
        effectiveStart: dates[0] || '',
        effectiveEnd: dates[dates.length - 1] || '',
        totalLegs: legs.length,
        totalSourceRows: 0,
        dataVersion: (existing?.dataVersion ?? 0) + 1,
        lastSyncedAt: uploadedAt,
      };
      let nextSeason: Season;

      if (existing) {
        setUploadProgress(buildImportProgress(`Patching season ${seasonCode}`, 32, `${affectedRecordIds.length} affected records`));
        seasonId = existing.id;
        await clearSourceRows(seasonId);
        if (modificationDeleteRecordIds.length > 0) {
          await deleteModifications(seasonId, modificationDeleteRecordIds);
        }
        await updateSeason(seasonId, seasonFields);
        nextSeason = { ...existing, ...seasonFields, id: seasonId };
      } else {
        setUploadProgress(buildImportProgress(`Creating season ${seasonCode}`, 28));
        seasonId = await createSeason(seasonFields as Omit<Season, 'id'>);
        nextSeason = { ...seasonFields, id: seasonId } as Season;
      }

      setUploadProgress(buildImportBatchProgress('Saving flight records', 0, recordsToWrite.length, 35, 90));
      if (recordsToWrite.length > 0) {
        await batchWriteFlightRecords(seasonId, recordsToWrite, (written, total) => {
          setUploadProgress(buildImportBatchProgress('Saving flight records', written, total, 35, 90));
        });
      }
      const verifiedCounts = await verifySeasonImportCounts(seasonId, {
        sourceRows: 0,
        flightRecords: seasonRecords.length,
      });
      const serverEventHighWater = await getSeasonEventHighWater(seasonId);

      setUploadProgress(buildImportProgress('Refreshing schedule', 94));
      const history: ModHistoryEntry[] = [];
      const patternRows = buildPatternRowsFromRecords(seasonRecords, seasonMods);
      const previousSeasons = getCachedSeasons() ?? seasons;
      const nextSeasons = existing
        ? previousSeasons.map((season) => season.id === seasonId ? nextSeason : season)
        : [nextSeason, ...previousSeasons];
      const workspace = createLocalWorkspace({
        season: nextSeason,
        rows: [],
        records: seasonRecords,
        modifications: seasonMods,
        modHistory: history,
        serverEventHighWater,
      });
      const imported = await importNativeSeasonSnapshot({
        season: nextSeason,
        sourceRows: [],
        records: seasonRecords,
        modifications: Array.from(seasonMods.values()),
        modHistory: [],
        serverEventHighWater,
        entityVersions: {},
      });
      if (!imported) {
        throw new Error('Native SQL snapshot import is unavailable. Desktop SQL storage is required.');
      }
      if (
        imported.sourceRows !== 0 ||
        imported.records !== seasonRecords.length ||
        imported.modifications !== seasonMods.size ||
        imported.modHistory !== 0
      ) {
        throw new Error(
          `Local SQL import count mismatch: sourceRows=${imported.sourceRows}/0, records=${imported.records}/${seasonRecords.length}, modifications=${imported.modifications}/${seasonMods.size}, history=${imported.modHistory}/0.`
        );
      }
      const localIntegrity = await checkNativeSeasonIntegrity(seasonId);
      if (!localIntegrity) {
        throw new Error('Native SQL integrity check is unavailable after import reset.');
      }
      if (
        localIntegrity.sourceRows !== 0 ||
        localIntegrity.baseSourceRows !== 0 ||
        localIntegrity.records !== seasonRecords.length ||
        localIntegrity.baseRecords !== seasonRecords.length ||
        localIntegrity.pendingOps !== 0
      ) {
        throw new Error(
          `Local SQL integrity mismatch after import: sourceRows=${localIntegrity.sourceRows}/0, baseSourceRows=${localIntegrity.baseSourceRows}/0, records=${localIntegrity.records}/${seasonRecords.length}, baseRecords=${localIntegrity.baseRecords}/${seasonRecords.length}, pendingOps=${localIntegrity.pendingOps}/0.`
        );
      }
      setCachedSeasons(nextSeasons);
      setCachedSeasonData(seasonId, { rows: patternRows, records: seasonRecords, modifications: seasonMods, seasonDataVersion: nextSeason.dataVersion });
      useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId,
        season: nextSeason,
        rows: patternRows,
        records: seasonRecords,
        modifications: seasonMods,
        syncMeta: imported.syncMeta,
        windowKey: buildSeasonalWindowKey({
          dateFrom: debouncedFilters.dateFrom || null,
          dateTo: debouncedFilters.dateTo || null,
          flight: debouncedFilters.flight || null,
          route: debouncedFilters.route || null,
        }),
      });
      publishSeasonalWorkspaceChange(
        seasonId,
        imported.syncMeta.localRevision ?? workspace.syncMeta.localRevision,
        affectedRecordIds,
        imported.syncMeta
      );
      void appendAuditLogEntry({
        seasonId,
        seasonCode,
        module: 'import',
        category: 'import',
        operation: existing
          ? `Patched season ${seasonCode}: ${patchStats.affected} affected records`
          : `Imported season ${seasonCode}: ${seasonRecords.length} flight records`,
        targetFlightIds: affectedRecordIds,
        targetFlightLabels: Array.from(new Set(recordsToWrite.map((record) => `${record.airline}${record.flightNumber}`))).slice(0, 200),
        deltas: [{
          targetType: 'sync',
          targetId: seasonId,
          targetLabel: seasonCode,
          field: 'importSummary',
          before: null,
          after: {
            sourceRows: 0,
            flightRecords: seasonRecords.length,
            importedFlightRecords: importedRecords.length,
            affectedFlightRecords: affectedRecordIds.length,
            effectiveStart: nextSeason.effectiveStart,
            effectiveEnd: nextSeason.effectiveEnd,
            fileName: file.name,
          },
        }],
        metadata: {
          sourceRows: 0,
          parsedRows: rows.length,
          flightRecords: seasonRecords.length,
          importedFlightRecords: importedRecords.length,
          affectedFlightRecords: affectedRecordIds.length,
          patchStats,
          duplicatePeriods: duplicatePeriods.length,
        },
      });
      setSeasons(nextSeasons);
      useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);
      setActiveSeason(nextSeason);
      sessionStorage.setItem('activeSeasonId', seasonId);
      applySeasonData(patternRows, seasonRecords, seasonMods);
      setPage(0);
      setUploadProgress(buildImportProgress('Import complete', 100, `${verifiedCounts.flightRecords} flight records`));
      if (duplicatePeriods.length > 0) {
        void showAlert({ title: 'Import Completed', message: formatDuplicateImportMessage(duplicatePeriods), tone: 'warning' });
      }
    } catch (err) {
      console.error('Upload error:', err);
      void showAlert({ title: 'Import Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [
    activeSeason,
    applySeasonData,
    debouncedFilters.dateFrom,
    debouncedFilters.dateTo,
    debouncedFilters.flight,
    debouncedFilters.route,
    loadSeasonRows,
    publishSeasonalWorkspaceChange,
    seasons,
    showAlert,
    showChoice,
    syncAnySeasonNow,
    fetchingUpdates,
    syncInProgress,
    uploading,
  ]);

  const handleRowDoubleClick = useCallback((group: DisplayGroup) => {
    if (!activeSeason) return;
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
              <SeasonConflictReviewControl seasonId={activeSeason?.id} />
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
          draftControls={hasDraftChanges && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900">
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              <span className="text-xs font-semibold">
                {(draftState?.records.length ?? 0) + (draftState?.modifications.length ?? 0)} draft changes
              </span>
              <button
                onClick={handleDiscardSeasonalDraft}
                disabled={syncInProgress}
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
                onClick={() => setIsNewFlightOpen(true)}
                disabled={syncInProgress || hasDraftChanges}
                title="Create a new seasonal flight"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                New Flight
              </button>
              <div className="relative">
                <button
                  className="flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-1.5 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={syncInProgress || hasDraftChanges || modHistory.length === 0 || isUndoing}
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
                              disabled={isUndoing}
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
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || fetchingUpdates || syncInProgress}
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
                disabled={activeDisplayLegs.length === 0 || selectedRecordIds.size === 0 || isExporting}
                title={isExporting ? 'Exporting selected flights' : selectedRecordIds.size === 0 ? 'Select flights to export' : 'Export selected flights'}
              >
                <span className={`material-symbols-outlined text-[16px] ${isExporting ? 'animate-spin' : ''}`}>{isExporting ? 'sync' : 'download'}</span>
                {isExporting ? 'Exporting...' : selectedRecordIds.size > 0 ? `Export (${selectedRecordIds.size})` : 'Export'}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-on-surface-variant">
              <span>{filteredGroups.length.toLocaleString()} groups after filters</span>
              <span>{selectedRecordIds.size.toLocaleString()} selected for export</span>
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
                      fetching={fetchingUpdates}
                      progress={fetchProgress}
                      disabled={syncInProgress}
                      onFetch={handleFetchUpdates}
                    />
                    <button
                      type="button"
                      onClick={() => { void handleRetryLoad(); }}
                      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md text-on-primary shadow-sm hover:bg-primary/90"
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
                    fetching={fetchingUpdates}
                    progress={fetchProgress}
                    disabled={syncInProgress}
                    onFetch={handleFetchUpdates}
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
                              checked={allFilteredSelected}
                              ref={(node) => {
                                if (node) node.indeterminate = hasPartialFilteredSelection;
                              }}
                              onChange={toggleAllFilteredSelection}
                              disabled={filteredRecordIds.length === 0}
                              aria-label="Select all flights in current table for export"
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
                                checked={group.recordIds.size > 0 && Array.from(group.recordIds).every((id) => selectedRecordIds.has(id))}
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
                                    className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold text-primary hover:bg-primary-container/40 transition-colors"
                                    title="Show matching flight legs to link"
                                    onClick={(e) => { e.stopPropagation(); setLinkModalGroupKey(group.key); }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link</span>
                                    Link
                                  </button>
                                )}
                                {linkAction.canUnlink && (
                                  <button
                                    className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold text-tertiary hover:bg-tertiary-container/40 transition-colors"
                                    title="Unlink this full Seasonal row"
                                    onClick={(e) => { e.stopPropagation(); handleUnlinkGroup(group); }}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">link_off</span>
                                    Unlink
                                  </button>
                                )}
                                <button
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-outline hover:bg-error-container hover:text-error transition-colors"
                                  title="Delete flight group"
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
                        disabled={linkingCandidateKey !== null}
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
          }
        }}
      />

      {dialogNode}

    </div>
  );
}
