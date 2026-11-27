'use client';

import { Suspense, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSessionState } from '../hooks/useSessionState';
import {
  getSeasons,
  getSeasonalPublishVersionsV1,
  getSeasonalDraftChangesPageV1,
  getSeasonalVersionChangesPageV1,
  getSeasonalDraftWindowV1,
  getSeasonalPublishedSnapshotPageV1,
  getDashboardSeasonData,
} from '@/lib/remoteStore';
import { isSeasonalPlanningV1Enabled } from '@/lib/seasonalPlanningContract';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import type { Season } from '@/lib/types';
import type { SeasonalPublishVersionSummary } from '@/lib/seasonalPlanningContract';
import {
  loadDashboardOverviewSource,
  type PlanningSourceKind,
  type PlanningSourceLoadResult,
} from '@/lib/planningDashboardSource';
import { PlanningOverview } from './components/PlanningOverview';
import { PlanningChangesPanel } from './components/PlanningChangesPanel';
import { SlotOccupancyReportPanel } from './components/SlotOccupancyReportPanel';
import SeasonalVersionHistoryModal from '../components/SeasonalVersionHistoryModal';
import { resolveOpsDate } from '@/lib/feasibleStdAnalysis';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';
import { formatUiError } from '@/lib/uiDisplayText';

export type DashboardTab = 'overview' | 'changes' | 'slot-report';
export type DashboardView = DashboardTab | 'operations' | 'report' | 'comparison' | 'ai-workspace';

function normalizeDashboardTab(view: string | null | undefined): DashboardTab {
  if (view === 'changes') return 'changes';
  if (view === 'slot-report') return 'slot-report';
  return 'overview';
}

function PlanningDashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const querySeasonId = searchParams?.get('season') ?? null;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useSessionScrollRestoration('dashboard:scroll', scrollContainerRef);

  // Tabs: 'overview' | 'changes' (supports legacy view strings via normalizer)
  const [dashboardViewState, setDashboardView] = useSessionState<DashboardView>('dashboard:view', 'overview');
  const planningV1Enabled = isSeasonalPlanningV1Enabled();
  const activeTab = planningV1Enabled ? normalizeDashboardTab(dashboardViewState) : 'overview';

  // Seasons state
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loadedSeasonsQuery, setLoadedSeasonsQuery] = useState<{ query: string | null } | null>(null);
  const loadingSeasons = !loadedSeasonsQuery || loadedSeasonsQuery.query !== querySeasonId;
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>('');

  // Source selection: 'draft' (default) vs specific published version
  const [sourceKind, setSourceKind] = useState<PlanningSourceKind>('draft');
  const [loadedVersionsSeasonId, setLoadedVersionsSeasonId] = useState<string | null>(null);
  const [rawPublishVersions, setRawPublishVersions] = useState<SeasonalPublishVersionSummary[]>([]);
  const [selectedVersionIdOverride, setSelectedVersionIdOverride] = useState<string | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState<SeasonalPublishVersionSummary | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const sourceLoadGeneration = useRef(0);

  const publishVersions = useMemo(() => {
    return selectedSeasonId && loadedVersionsSeasonId === selectedSeasonId ? rawPublishVersions : [];
  }, [selectedSeasonId, loadedVersionsSeasonId, rawPublishVersions]);

  const selectedVersionId = useMemo(() => {
    if (selectedVersionIdOverride && publishVersions.some((v) => v.version_id === selectedVersionIdOverride)) {
      return selectedVersionIdOverride;
    }
    return publishVersions[0]?.version_id ?? '';
  }, [selectedVersionIdOverride, publishVersions]);

  // Date range filter overrides (defaults to season bounds)
  const [userDateFrom, setUserDateFrom] = useState<string | null>(null);
  const [userDateTo, setUserDateTo] = useState<string | null>(null);
  // User explicitly selected opsDate override
  const [selectedOpsDateOverride, setSelectedOpsDateOverride] = useState<string | null>(null);

  // Raw planning flight records for the currently selected source
  const [loadedSourceResult, setLoadedSourceResult] = useState<PlanningSourceLoadResult>({
    identity: { seasonId: '', sourceKind: 'draft' },
    seasonId: '',
    flights: [],
    status: 'idle',
    error: null,
    isStale: false,
    isEmpty: true,
    totalCount: 0,
  });

  const targetSourceIdentityKey = `${selectedSeasonId}:${sourceKind}:${sourceKind === 'published' ? selectedVersionId : ''}`;
  const loadedSourceIdentityKey = `${loadedSourceResult.seasonId}:${loadedSourceResult.identity.sourceKind}:${loadedSourceResult.identity.versionId ?? ''}`;
  const isSourceMatching = !loadingSeasons && Boolean(selectedSeasonId) && targetSourceIdentityKey === loadedSourceIdentityKey;

  const sourceData: PlanningSourceLoadResult = useMemo(() => {
    if (!selectedSeasonId) {
      return {
        identity: { seasonId: '', sourceKind },
        seasonId: '',
        flights: [],
        status: 'idle',
        error: null,
        isStale: false,
        isEmpty: true,
        totalCount: 0,
      };
    }
    if (!isSourceMatching || isRefreshing) {
      return {
        identity: {
          seasonId: selectedSeasonId,
          sourceKind,
          versionId: sourceKind === 'published' ? selectedVersionId : undefined,
        },
        seasonId: selectedSeasonId,
        flights: [],
        status: 'loading',
        error: null,
        isStale: false,
        isEmpty: true,
        totalCount: 0,
      };
    }
    return loadedSourceResult;
  }, [selectedSeasonId, sourceKind, selectedVersionId, isSourceMatching, loadedSourceResult, isRefreshing]);

  // Summary diff for Overview tab (comparing draft with latest published version)
  const [rawOverviewDiffSummary, setRawOverviewDiffSummary] = useState<{
    comparisonKey: string;
    added: number;
    modified: number;
    removed: number;
    total: number;
    baseTag: string;
  } | null>(null);

  // Base version selected for Draft comparison (shared between overview diff and changes panel)
  const [selectedBaseVersionId, setSelectedBaseVersionId] = useState<string>('');
  const comparisonKey = `${targetSourceIdentityKey}:${sourceData.identity.draftEpoch ?? ''}:${sourceData.identity.draftRevision ?? ''}:${sourceKind === 'draft' ? selectedBaseVersionId || publishVersions[0]?.version_id || '' : ''}`;
  const overviewDiffSummary = sourceData.status === 'success' && rawOverviewDiffSummary?.comparisonKey === comparisonKey ? rawOverviewDiffSummary : null;
  // 1. Initial Load of Seasons
  useEffect(() => {
    let active = true;
    getSeasons()
      .then((loaded) => {
        if (!active) return;
        setSeasons(loaded);
        useSeasonWorkspaceStore.getState().setSeasons(loaded);

        // Resolve active season ID: queryParam > sessionStorage > first season
        let targetId = '';
        if (querySeasonId && loaded.some((s) => s.id === querySeasonId)) {
          targetId = querySeasonId;
        } else {
          const stored = typeof window !== 'undefined' ? sessionStorage.getItem('activeSeasonId') : null;
          if (stored && loaded.some((s) => s.id === stored)) {
            targetId = stored;
          } else if (loaded.length > 0) {
            targetId = loaded[0].id;
          }
        }
        setSelectedSeasonId(targetId);
      })
      .catch(() => {
        if (!active) return;
        setSeasons([]);
      })
      .finally(() => {
        if (active) setLoadedSeasonsQuery({ query: querySeasonId });
      });

    return () => {
      active = false;
    };
  }, [querySeasonId]);

  // Selected Season object
  const currentSeason = useMemo(() => {
    return seasons.find((s) => s.id === selectedSeasonId) ?? null;
  }, [seasons, selectedSeasonId]);

  const dateFrom = userDateFrom ?? currentSeason?.effectiveStart ?? '';
  const dateTo = userDateTo ?? currentSeason?.effectiveEnd ?? '';

  // 2. Load Published Versions for Selected Season
  useEffect(() => {
    if (!planningV1Enabled || !selectedSeasonId) {
      setRawPublishVersions([]);
      setLoadedVersionsSeasonId(selectedSeasonId || null);
      setSelectedBaseVersionId('');
      return;
    }

    let active = true;
    getSeasonalPublishVersionsV1({ seasonId: selectedSeasonId, pageSize: 100 })
      .then((res) => {
        if (!active) return;
        setRawPublishVersions(res.versions);
        setLoadedVersionsSeasonId(selectedSeasonId);
        setSelectedBaseVersionId(res.versions[0]?.version_id ?? '');
      })
      .catch(() => {
        if (!active) return;
        setRawPublishVersions([]);
        setLoadedVersionsSeasonId(selectedSeasonId);
        setSelectedBaseVersionId('');
      });

    return () => {
      active = false;
    };
  }, [planningV1Enabled, selectedSeasonId]);

  // 3. Load the source supported by the selected client/backend contract.
  useEffect(() => {
    const requestSourceKind = planningV1Enabled ? sourceKind : 'draft';
    if (!selectedSeasonId) return;
    if (planningV1Enabled && requestSourceKind === 'published' && !selectedVersionId) return;

    let active = true;
    const generation = ++sourceLoadGeneration.current;
    loadDashboardOverviewSource({
      seasonId: selectedSeasonId,
      planningV1Enabled,
      sourceKind: requestSourceKind,
      versionId: requestSourceKind === 'published' ? selectedVersionId : undefined,
      draftTransportFn: getSeasonalDraftWindowV1,
      publishedTransportFn: getSeasonalPublishedSnapshotPageV1,
      legacyTransportFn: getDashboardSeasonData,
    })
      .then((result) => {
        if (!active || generation !== sourceLoadGeneration.current) return;
        setLoadedSourceResult(result);
      })
      .catch((err: unknown) => {
        if (!active || generation !== sourceLoadGeneration.current) return;
        const msg = formatUiError(err, 'Không thể tải nguồn kế hoạch.');
        setLoadedSourceResult({
          identity: {
            seasonId: selectedSeasonId,
            sourceKind: requestSourceKind,
            versionId: requestSourceKind === 'published' ? selectedVersionId : undefined,
          },
          seasonId: selectedSeasonId,
          flights: [],
          status: 'error',
          error: msg,
          isStale: false,
          isEmpty: true,
          totalCount: 0,
        });
      })
      .finally(() => {
        if (active && generation === sourceLoadGeneration.current) setIsRefreshing(false);
      });

    return () => {
      active = false;
    };
  }, [planningV1Enabled, selectedSeasonId, sourceKind, selectedVersionId]);

  // Manual refresh uses the same explicit contract selection as initial load.
  const handleRefreshSource = useCallback(async () => {
    if (!selectedSeasonId) return;
    const generation = ++sourceLoadGeneration.current;
    setIsRefreshing(true);
    try {
      const result = await loadDashboardOverviewSource({
        seasonId: selectedSeasonId,
        planningV1Enabled,
        sourceKind: planningV1Enabled ? sourceKind : 'draft',
        versionId: planningV1Enabled && sourceKind === 'published' ? selectedVersionId : undefined,
        draftTransportFn: getSeasonalDraftWindowV1,
        publishedTransportFn: getSeasonalPublishedSnapshotPageV1,
        legacyTransportFn: getDashboardSeasonData,
      });
      if (generation !== sourceLoadGeneration.current) return;
      setLoadedSourceResult(result);
    } catch (err: unknown) {
      if (generation !== sourceLoadGeneration.current) return;
      const msg = formatUiError(err, 'Không thể làm mới nguồn kế hoạch.');
      setLoadedSourceResult((prev) => ({
        ...prev,
        status: 'error',
        error: msg,
      }));
    } finally {
      if (generation === sourceLoadGeneration.current) setIsRefreshing(false);
    }
  }, [planningV1Enabled, selectedSeasonId, sourceKind, selectedVersionId]);
  useSeasonWorkspaceRefresh({
    seasonId: sourceKind === 'draft' ? selectedSeasonId : null,
    policy: 'background',
    source: 'planning-dashboard',
    onRefresh: handleRefreshSource,
  });

  useEffect(() => {
    if (!planningV1Enabled || !selectedSeasonId) return;
    if (sourceData.status !== 'success' || loadedVersionsSeasonId !== selectedSeasonId) return;

    let active = true;

    if (sourceKind === 'draft') {
      const baseId = selectedBaseVersionId || (publishVersions[0]?.version_id ?? null);
      getSeasonalDraftChangesPageV1({
        seasonId: selectedSeasonId,
        baseVersionId: baseId,
        pageSize: 1,
        expectedEpoch: sourceData.identity.draftEpoch ?? null,
        expectedRevision: sourceData.identity.draftRevision ?? null,
      })
        .then((res) => {
          if (!active) return;
          if (res.summary) {
            setRawOverviewDiffSummary({
              comparisonKey,
              added: res.summary.added,
              modified: res.summary.modified,
              removed: res.summary.removed,
              total: res.summary.totalChanges,
              baseTag:
                res.baseVersion?.versionTag ||
                (publishVersions.find((v) => v.version_id === baseId)?.version_tag ?? 'Khởi tạo'),
            });
          }
        })
        .catch(() => {
          if (!active) return;
          setRawOverviewDiffSummary(null);
        });
    } else if (sourceKind === 'published' && selectedVersionId) {
      getSeasonalVersionChangesPageV1({
        versionId: selectedVersionId,
        pageSize: 1,
      })
        .then((res) => {
          if (!active) return;
          if (res.summary) {
            setRawOverviewDiffSummary({
              comparisonKey,
              added: res.summary.added,
              modified: res.summary.modified,
              removed: res.summary.removed,
              total: res.summary.totalChanges,
              baseTag: res.baseVersion?.versionTag || 'Bản trước',
            });
          }
        })
        .catch(() => {
          if (!active) return;
          setRawOverviewDiffSummary(null);
        });
    }

    return () => {
      active = false;
    };
  }, [planningV1Enabled, selectedSeasonId, sourceKind, selectedVersionId, publishVersions, selectedBaseVersionId, sourceData.identity.draftEpoch, sourceData.identity.draftRevision, sourceData.status, loadedVersionsSeasonId, comparisonKey]);

  // Available operational dates extracted from loaded source flights
  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    for (const f of sourceData.flights) {
      if (f.status === 'deleted' || f.action === 'deleted') continue;
      const scheduledDate = f.scheduled_date || f.date;
      const d = scheduledDate ? resolveOpsDate(scheduledDate, f.schedule) : '';
      if (d) {
        if (dateFrom && d < dateFrom) continue;
        if (dateTo && d > dateTo) continue;
        dates.add(d);
      }
    }
    return Array.from(dates).sort();
  }, [sourceData.flights, dateFrom, dateTo]);

  // Derived selectedOpsDate: if override is valid in availableDates, use it; else default to availableDates[0] or ''
  const selectedOpsDate = useMemo(() => {
    if (selectedOpsDateOverride && availableDates.includes(selectedOpsDateOverride)) {
      return selectedOpsDateOverride;
    }
    return availableDates[0] ?? '';
  }, [selectedOpsDateOverride, availableDates]);

  const openSeasonal = useCallback(() => {
    if (!selectedSeasonId) return;
    sessionStorage.setItem('activeSeasonId', selectedSeasonId);
    router.push('/seasonal');
  }, [router, selectedSeasonId]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      {/* 1. Header with Planning Context: Season -> Source -> Date Range */}
      <header className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left Title & Season */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[24px] text-primary">dashboard</span>
              <span className="text-base font-bold text-slate-900 dark:text-white">
                {planningV1Enabled ? 'Tổng quan kế hoạch' : 'Tổng quan lịch mùa'}
              </span>
            </div>

            {/* Season Selector */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="planning-season-select" className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Mùa:
              </label>
              <select
                id="planning-season-select"
                value={selectedSeasonId}
                onChange={(e) => {
                  const newSeasonId = e.target.value;
                  setSelectedSeasonId(newSeasonId);
                  setUserDateFrom(null);
                  setUserDateTo(null);
                  setSelectedVersionIdOverride(null);
                  setSourceKind('draft');
                  if (typeof window !== 'undefined') {
                    sessionStorage.setItem('activeSeasonId', newSeasonId);
                  }
                }}
                disabled={loadingSeasons || seasons.length === 0}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {seasons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.seasonCode})
                  </option>
                ))}
              </select>
            </div>

            {planningV1Enabled ? (
              <>
                <div className="flex items-center gap-1.5">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Nguồn kế hoạch:
                </label>
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setSourceKind('draft')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                      sourceKind === 'draft'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    Bản nháp (hiện hành)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceKind('published')}
                    disabled={publishVersions.length === 0}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      sourceKind === 'published'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    Đã công bố ({publishVersions.length})
                  </button>
                </div>
                {sourceKind === 'published' && publishVersions.length > 0 && (
                  <select
                    value={selectedVersionId}
                    onChange={(e) => setSelectedVersionIdOverride(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  >
                    {publishVersions.map((v) => (
                      <option key={v.version_id} value={v.version_id}>
                        {v.version_tag} ({v.published_at.slice(0, 10)})
                      </option>
                    ))}
                  </select>
                )}
                </div>
              </>
            ) : (
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Nguồn: Lịch mùa hiện hành (workspace cũ). Công bố và so sánh chỉ có ở Planning V1.
              </span>
            )}
            <button
              type="button"
              onClick={handleRefreshSource}
              disabled={isRefreshing || sourceData.status === 'loading'}
              title="Làm mới dữ liệu nguồn"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <span className={`material-symbols-outlined text-[16px] ${isRefreshing ? 'animate-spin' : ''}`}>
                refresh
              </span>
              <span>Làm mới</span>
            </button>
            {/* Date Range Controls */}
            <div className="flex items-center gap-1 text-xs">
              <span className="font-semibold text-slate-500 dark:text-slate-400">Từ:</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setUserDateFrom(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
              <span className="font-semibold text-slate-500 dark:text-slate-400">Đến:</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setUserDateTo(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </div>
          </div>

          {/* Drill down into the selected Planning source, never Operations live. */}
          <div className="flex items-center gap-2">
            {sourceKind === 'draft' ? (
              <button
                type="button"
                onClick={openSeasonal}
                disabled={!selectedSeasonId}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">calendar_month</span>
                <span>Chọn chuyến tại Lịch mùa</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSnapshotVersion(publishVersions.find((v) => v.version_id === selectedVersionId) ?? null)}
                disabled={sourceData.status !== 'success' || !selectedVersionId}
                className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300"
              >
                Mở bản lưu chỉ đọc
              </button>
            )}
          </div>
        </div>

        {/* 2. Compact Tabs Navigation */}
        <div className="mt-3 flex items-center border-t border-slate-100 pt-2.5 dark:border-slate-800">
          <nav className="flex space-x-2" aria-label="Các thẻ tổng quan">
            <button
              type="button"
              onClick={() => setDashboardView('overview')}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                activeTab === 'overview'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">overview</span>
              <span>{planningV1Enabled ? 'Tổng quan kế hoạch' : 'Tổng quan lịch mùa'}</span>
            </button>
            {planningV1Enabled && (
            <button
              type="button"
              onClick={() => setDashboardView('changes')}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                activeTab === 'changes'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">compare_arrows</span>
              <span>Thay đổi kế hoạch</span>
            </button>
            )}
            <button
              type="button"
              onClick={() => setDashboardView('slot-report')}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                activeTab === 'slot-report'
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">analytics</span>
              <span>Báo cáo Slot (STD)</span>
            </button>
          </nav>
        </div>
      </header>

      {/* 3. Main Dashboard Body */}
      <main ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 sm:p-5">
        {activeTab === 'overview' ? (
          <PlanningOverview
            flights={sourceData.flights}
            dateFrom={dateFrom}
            dateTo={dateTo}
            seasonRange={
              currentSeason?.effectiveStart && currentSeason?.effectiveEnd
                ? { start: currentSeason.effectiveStart, end: currentSeason.effectiveEnd }
                : undefined
            }
            selectedOpsDate={selectedOpsDate}
            onSelectOpsDate={setSelectedOpsDateOverride}
            availableDates={availableDates}
            loading={sourceData.status === 'loading'}
            error={sourceData.error}
            isStale={sourceData.isStale}
            diffSummary={planningV1Enabled ? overviewDiffSummary : null}
            onViewChangesTab={() => setDashboardView('changes')}
          />
        ) : activeTab === 'slot-report' ? (
          <SlotOccupancyReportPanel
            flights={sourceData.flights}
            seasonCode={currentSeason?.code ?? selectedSeasonId ?? 'W26'}
            dateFrom={dateFrom}
            dateTo={dateTo}
            loading={sourceData.status === 'loading'}
            error={sourceData.error}
            isStale={sourceData.isStale}
          />
        ) : (
          <PlanningChangesPanel
            seasonId={selectedSeasonId}
            sourceKind={sourceKind}
            selectedVersionId={selectedVersionId}
            draftFlights={sourceData.flights}
            versions={publishVersions}
            selectedBaseVersionId={selectedBaseVersionId}
            onSelectBaseVersionId={setSelectedBaseVersionId}
            draftEpoch={sourceData.identity.draftEpoch}
            draftRevision={sourceData.identity.draftRevision}
            disabled={sourceData.status === 'loading'}
          />
        )}
      </main>
      {snapshotVersion && sourceKind === 'published' && (
        <SeasonalVersionHistoryModal
          key={snapshotVersion.version_id}
          isOpen
          seasonId={selectedSeasonId}
          seasonCode={currentSeason?.seasonCode || currentSeason?.code || ''}
          initialVersion={snapshotVersion}
          readOnly
          restrictedReason="Bản lưu trên Tổng quan chỉ đọc; khôi phục bản nháp tại Lịch mùa hoặc Lịch chi tiết."
          onClose={() => setSnapshotVersion(null)}
          onDraftRestored={handleRefreshSource}
        />
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-surface text-on-surface">
          Đang tải tổng quan kế hoạch...
        </div>
      }
    >
      <PlanningDashboardContent />
    </Suspense>
  );
}
