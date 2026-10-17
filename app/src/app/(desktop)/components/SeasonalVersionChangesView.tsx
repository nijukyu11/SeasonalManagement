'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getSeasonalVersionChangesPageV1 } from '@/lib/remoteStore';
import {
  formatFlightNumber,
  formatFlightDescriptor,
  formatDiffSummary,
  formatDayRanges,
  formatDateDisplay,
  formatSingleValue,
  CANONICAL_FIELD_DEFS,
  areValuesEquivalent,
  getCanonicalValue,
} from '@/lib/seasonalDiffFormatters';
import { formatUiError, formatUiFieldLabel, formatUiRecord, formatUiValue } from '@/lib/uiDisplayText';
import type {
  SeasonalPublishVersionSummary,
  SeasonalVersionChangeRow,
  SeasonalVersionChangesInput,
  SeasonalVersionChangesResult,
} from '@/lib/seasonalPlanningContract';

export interface SeasonalVersionChangesViewProps {
  versionId?: string;
  disabled?: boolean;
  versions?: SeasonalPublishVersionSummary[];
  loadPageOverride?: (input: SeasonalVersionChangesInput) => Promise<SeasonalVersionChangesResult>;
}

interface GroupDaysState {
  entries: SeasonalVersionChangeRow[];
  hasMore: boolean;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  generation: number;
}

export default function SeasonalVersionChangesView({
  versionId = '',
  disabled = false,
  versions = [],
  loadPageOverride,
}: SeasonalVersionChangesViewProps) {
  // View mode: 'groups' (default) or 'days'
  const [viewMode, setViewMode] = useState<'groups' | 'days'>('groups');

  // Custom base version mode
  const [isCustomBaseMode, setIsCustomBaseMode] = useState(false);
  const [customBaseVersionId, setCustomBaseVersionId] = useState<string>('');

  // Filters
  const [changeTypeFilter, setChangeTypeFilter] = useState<'all' | 'added' | 'removed' | 'modified'>('all');
  const [fieldFilter, setFieldFilter] = useState<'all' | 'time' | 'route' | 'aircraft' | 'other'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Comparison result & pagination state
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SeasonalVersionChangeRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [summary, setSummary] = useState<SeasonalVersionChangesResult['summary'] | null>(null);
  const [totalRows, setTotalRows] = useState(0);
  const [filteredOccurrenceCount, setFilteredOccurrenceCount] = useState(0);
  const [baseVersionMeta, setBaseVersionMeta] = useState<SeasonalVersionChangesResult['baseVersion']>(null);
  const [currentVersionMeta, setCurrentVersionMeta] = useState<SeasonalVersionChangesResult['version'] | null>(null);

  // Row expansion state
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [showUnchangedFields, setShowUnchangedFields] = useState<Record<string, boolean>>({});

  // Per-group days expansion state with pagination and error handling
  const [groupDaysMap, setGroupDaysMap] = useState<Record<string, GroupDaysState>>({});
  const [expandedGroupDaysView, setExpandedGroupDaysView] = useState<Record<string, boolean>>({});
  const groupDaysGenerationsRef = useRef<Record<string, number>>({});

  // Race generations and cursor refs
  const fetchGenerationRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);

  // Available base versions (exclude current selected version)
  const availableBaseVersions = versions.filter((v) => !versionId || v.version_id !== versionId);

  // Primary loader
  const loadChanges = useCallback(
    async (reset = true) => {
      // Invalidate any in-flight requests
      const gen = ++fetchGenerationRef.current;

      // If user selected custom base mode but hasn't picked a version yet, don't execute
      if (isCustomBaseMode && !customBaseVersionId) {
        setEntries([]);
        setHasMore(false);
        nextCursorRef.current = null;
        setSummary(null);
        setTotalRows(0);
        setFilteredOccurrenceCount(0);
        setBaseVersionMeta(null);
        setCurrentVersionMeta(null);
        setLoading(false);
        setLoadingMore(false);
        setError(null);
        return;
      }

      if (reset) {
        setLoading(true);
        setError(null);
        setEntries([]);
        setHasMore(false);
        nextCursorRef.current = null;
        setSummary(null);
        setTotalRows(0);
        setFilteredOccurrenceCount(0);
        setBaseVersionMeta(null);
        setCurrentVersionMeta(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const cursor = reset ? undefined : (nextCursorRef.current ?? undefined);
        const fetchPage = loadPageOverride ?? getSeasonalVersionChangesPageV1;
        const res = await fetchPage({
          versionId,
          baseVersionId: isCustomBaseMode ? customBaseVersionId : undefined,
          view: viewMode,
          afterCursor: cursor,
          pageSize: 50,
          changeType: changeTypeFilter,
          search: debouncedSearch || undefined,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          field: fieldFilter,
        });

        if (gen !== fetchGenerationRef.current) return;

        nextCursorRef.current = res.nextCursor;
        setHasMore(res.hasMore);
        setEntries((prev) => (reset ? res.entries : [...prev, ...res.entries]));
        setSummary(res.summary);
        setTotalRows(res.totalRows);
        setFilteredOccurrenceCount(res.filteredOccurrenceCount);
        setBaseVersionMeta(res.baseVersion);
        setCurrentVersionMeta(res.version);
      } catch (err: unknown) {
        if (gen !== fetchGenerationRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        if (reset) {
          setEntries([]);
          setHasMore(false);
          nextCursorRef.current = null;
          setSummary(null);
          setTotalRows(0);
          setFilteredOccurrenceCount(0);
          setBaseVersionMeta(null);
          setCurrentVersionMeta(null);
        }
      } finally {
        if (gen === fetchGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [
      versionId,
      isCustomBaseMode,
      customBaseVersionId,
      viewMode,
      changeTypeFilter,
      debouncedSearch,
      dateFrom,
      dateTo,
      fieldFilter,
    ],
  );

  // Trigger primary loader when filters or versions change
  useEffect(() => {
    let cancelled = false;
    setExpandedRows({});
    setGroupDaysMap({});
    setExpandedGroupDaysView({});

    queueMicrotask(() => {
      if (cancelled) return;
      void loadChanges(true);
    });

    return () => {
      cancelled = true;
      fetchGenerationRef.current += 1;
    };
  }, [loadChanges]);

  // Load exact day rows for a group with pagination, error handling, and filter propagation
  const loadGroupDays = useCallback(
    async (groupKey: string, reset = true) => {
      const mainGen = fetchGenerationRef.current;
      const currentGroupGen = (groupDaysGenerationsRef.current[groupKey] ?? 0) + 1;
      groupDaysGenerationsRef.current[groupKey] = currentGroupGen;

      setGroupDaysMap((prev) => {
        const existing = prev[groupKey];
        return {
          ...prev,
          [groupKey]: {
            entries: reset ? [] : (existing?.entries ?? []),
            hasMore: reset ? false : (existing?.hasMore ?? false),
            nextCursor: reset ? null : (existing?.nextCursor ?? null),
            loading: reset,
            loadingMore: !reset,
            error: null,
            generation: currentGroupGen,
          },
        };
      });

      try {
        const currentGroupState = groupDaysMap[groupKey];
        const cursor = reset ? undefined : (currentGroupState?.nextCursor ?? undefined);

        const fetchPage = loadPageOverride ?? getSeasonalVersionChangesPageV1;
        const res = await fetchPage({
          versionId,
          baseVersionId: isCustomBaseMode ? customBaseVersionId : undefined,
          view: 'days',
          groupKey,
          afterCursor: cursor,
          pageSize: 50,
          changeType: changeTypeFilter,
          search: debouncedSearch || undefined,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          field: fieldFilter,
        });

        if (mainGen !== fetchGenerationRef.current) return;
        if (currentGroupGen !== groupDaysGenerationsRef.current[groupKey]) return;

        setGroupDaysMap((prev) => ({
          ...prev,
          [groupKey]: {
            entries: reset ? res.entries : [...(prev[groupKey]?.entries ?? []), ...res.entries],
            hasMore: res.hasMore,
            nextCursor: res.nextCursor,
            loading: false,
            loadingMore: false,
            error: null,
            generation: currentGroupGen,
          },
        }));
      } catch (err: unknown) {
        if (mainGen !== fetchGenerationRef.current) return;
        if (currentGroupGen !== groupDaysGenerationsRef.current[groupKey]) return;

        setGroupDaysMap((prev) => ({
          ...prev,
          [groupKey]: {
            entries: prev[groupKey]?.entries ?? [],
            hasMore: prev[groupKey]?.hasMore ?? false,
            nextCursor: prev[groupKey]?.nextCursor ?? null,
            loading: false,
            loadingMore: false,
            error: err instanceof Error ? err.message : String(err),
            generation: currentGroupGen,
          },
        }));
      }
    },
    [
      versionId,
      isCustomBaseMode,
      customBaseVersionId,
      changeTypeFilter,
      debouncedSearch,
      dateFrom,
      dateTo,
      fieldFilter,
      groupDaysMap,
    ],
  );

  const handleToggleGroupDays = (groupKey: string) => {
    const isCurrentlyOpen = expandedGroupDaysView[groupKey];
    if (isCurrentlyOpen) {
      setExpandedGroupDaysView((prev) => ({ ...prev, [groupKey]: false }));
      return;
    }

    setExpandedGroupDaysView((prev) => ({ ...prev, [groupKey]: true }));
    const existing = groupDaysMap[groupKey];
    if (!existing || existing.entries.length === 0) {
      void loadGroupDays(groupKey, true);
    }
  };

  const handleResetFilters = () => {
    setChangeTypeFilter('all');
    setFieldFilter('all');
    setSearchInput('');
    setDateFrom('');
    setDateTo('');
  };

  const isCustomBasePendingSelection = isCustomBaseMode && !customBaseVersionId;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface text-on-surface">
      {/* Top Header: Comparison Direction & Metadata */}
      <div className="border-b border-outline-variant bg-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-semibold text-on-surface-variant">So sánh:</span>
            {baseVersionMeta ? (
              <span className="inline-flex items-center gap-1 font-mono font-bold bg-surface-variant/40 px-2 py-0.5 rounded text-on-surface">
                {baseVersionMeta.versionTag}
                <span className="text-[10px] font-normal text-on-surface-variant">
                  ({new Date(baseVersionMeta.publishedAt).toLocaleDateString('vi-VN')})
                </span>
              </span>
            ) : loading ? (
              <span className="text-on-surface-variant italic">Đang xác định bản đối chiếu...</span>
            ) : (
              <span className="text-on-surface-variant italic">Bản gốc đầu tiên (không có bản trước)</span>
            )}

            <span className="text-on-surface-variant font-bold">→</span>

            <span className="inline-flex items-center gap-1 font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">
              {currentVersionMeta?.versionTag ?? 'Bản đang chọn'}
              {currentVersionMeta?.publishedAt && (
                <span className="text-[10px] font-normal opacity-80">
                  ({new Date(currentVersionMeta.publishedAt).toLocaleDateString('vi-VN')})
                </span>
              )}
            </span>
          </div>

          {currentVersionMeta?.notes && (
            <p className="text-[11px] text-on-surface-variant line-clamp-1">Ghi chú: {currentVersionMeta.notes}</p>
          )}
        </div>

        {/* Comparison mode controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {!isCustomBaseMode ? (
            <button
              type="button"
              disabled={disabled || availableBaseVersions.length === 0}
              onClick={() => setIsCustomBaseMode(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-outline-variant px-2.5 py-1 text-xs font-semibold text-on-surface hover:bg-surface-variant/40 disabled:opacity-40"
              title="Chọn phiên bản khác để đối chiếu thay vì phiên bản liền trước"
            >
              <span className="material-symbols-outlined text-[16px]">compare_arrows</span>
              <span>Đổi bản đối chiếu</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <label htmlFor="custom-base-select" className="text-xs font-medium text-on-surface-variant">
                Bản đối chiếu:
              </label>
              <select
                id="custom-base-select"
                value={customBaseVersionId}
                onChange={(e) => setCustomBaseVersionId(e.target.value)}
                disabled={disabled}
                className="rounded-lg border border-outline-variant px-2 py-1 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">-- Chọn bản đối chiếu --</option>
                {availableBaseVersions.map((v) => (
                  <option key={v.version_id} value={v.version_id}>
                    {v.version_tag} ({new Date(v.published_at).toLocaleDateString('vi-VN')})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setIsCustomBaseMode(false);
                  setCustomBaseVersionId('');
                }}
                disabled={disabled}
                className="rounded-lg border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
              >
                Mặc định (liền trước)
              </button>
            </div>
          )}

          {/* View mode toggle: Groups vs Days */}
          <div className="inline-flex rounded-lg border border-outline-variant p-0.5 bg-surface-variant/20 ml-2">
            <button
              type="button"
              onClick={() => setViewMode('groups')}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'groups' ? 'bg-surface text-primary shadow-sm font-bold' : 'text-on-surface-variant'
              }`}
            >
              Nhóm chặng bay
            </button>
            <button
              type="button"
              onClick={() => setViewMode('days')}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                viewMode === 'days' ? 'bg-surface text-primary shadow-sm font-bold' : 'text-on-surface-variant'
              }`}
            >
              Từng ngày chi tiết
            </button>
          </div>
        </div>
      </div>

      {/* Summary KPI Cards: 4 full-pair counts explicitly "chặng bay theo ngày" */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-surface-variant/10 border-b border-outline-variant text-xs">
          <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
            <span className="material-symbols-outlined text-emerald-600 text-[20px]">add_circle</span>
            <div>
              <div className="text-[10px] uppercase font-bold text-emerald-700 dark:text-emerald-300">Thêm mới</div>
              <div className="text-sm font-bold text-on-surface">
                {summary.added.toLocaleString('vi-VN')}{' '}
                <span className="text-[10px] font-normal text-on-surface-variant">chặng theo ngày</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5">
            <span className="material-symbols-outlined text-rose-600 text-[20px]">remove_circle</span>
            <div>
              <div className="text-[10px] uppercase font-bold text-rose-700 dark:text-rose-300">Xóa</div>
              <div className="text-sm font-bold text-on-surface">
                {summary.removed.toLocaleString('vi-VN')}{' '}
                <span className="text-[10px] font-normal text-on-surface-variant">chặng theo ngày</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
            <span className="material-symbols-outlined text-amber-600 text-[20px]">edit</span>
            <div>
              <div className="text-[10px] uppercase font-bold text-amber-700 dark:text-amber-300">Điều chỉnh</div>
              <div className="text-sm font-bold text-on-surface">
                {summary.modified.toLocaleString('vi-VN')}{' '}
                <span className="text-[10px] font-normal text-on-surface-variant">chặng theo ngày</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-outline-variant bg-surface p-2.5">
            <span className="material-symbols-outlined text-on-surface-variant text-[20px]">check_circle</span>
            <div>
              <div className="text-[10px] uppercase font-bold text-on-surface-variant">Không đổi</div>
              <div className="text-sm font-bold text-on-surface">
                {summary.unchanged.toLocaleString('vi-VN')}{' '}
                <span className="text-[10px] font-normal text-on-surface-variant">chặng theo ngày</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="p-3 border-b border-outline-variant bg-surface flex flex-wrap items-center gap-2.5 text-xs">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-on-surface-variant">
            search
          </span>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            disabled={disabled}
            placeholder="Tìm số hiệu, hãng, tuyến, tàu..."
            className="w-full rounded-lg border border-outline-variant bg-surface pl-8 pr-2.5 py-1 text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Change Type Filter */}
        <div className="flex items-center gap-1">
          <label htmlFor="filter-change-type" className="text-on-surface-variant">
            Loại:
          </label>
          <select
            id="filter-change-type"
            value={changeTypeFilter}
            onChange={(e) => setChangeTypeFilter(e.target.value as typeof changeTypeFilter)}
            disabled={disabled}
            className="rounded-lg border border-outline-variant px-2 py-1 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">Tất cả thay đổi</option>
            <option value="added">Thêm mới</option>
            <option value="removed">Xóa</option>
            <option value="modified">Điều chỉnh</option>
          </select>
        </div>

        {/* Field Filter */}
        <div className="flex items-center gap-1">
          <label htmlFor="filter-field" className="text-on-surface-variant">
            Trường:
          </label>
          <select
            id="filter-field"
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value as typeof fieldFilter)}
            disabled={disabled}
            className="rounded-lg border border-outline-variant px-2 py-1 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">Tất cả trường</option>
            <option value="time">Giờ bay</option>
            <option value="route">Tuyến bay</option>
            <option value="aircraft">Tàu bay</option>
            <option value="other">Trường khác</option>
          </select>
        </div>

        {/* Date From & To */}
        <div className="flex items-center gap-1">
          <span className="text-on-surface-variant">Từ:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-outline-variant px-2 py-1 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex items-center gap-1">
          <span className="text-on-surface-variant">Đến:</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-outline-variant px-2 py-1 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Reset Filter Button */}
        {(changeTypeFilter !== 'all' ||
          fieldFilter !== 'all' ||
          searchInput.trim() !== '' ||
          dateFrom !== '' ||
          dateTo !== '') && (
          <button
            type="button"
            onClick={handleResetFilters}
            className="rounded-lg border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
          >
            Xóa bộ lọc
          </button>
        )}

        {/* Filtered Count indicator */}
        <div className="ml-auto text-[11px] text-on-surface-variant">
          Hiển thị: <strong>{entries.length}</strong> / <strong>{totalRows}</strong>{' '}
          {viewMode === 'groups' ? 'nhóm' : 'chặng'}
          {filteredOccurrenceCount > 0 && (
            <span className="ml-1 text-primary">({filteredOccurrenceCount} lượt chặng)</span>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        {/* Error notification */}
        {error && (
          <div className="m-4 rounded-xl bg-error/10 border border-error/20 p-3 text-xs text-error flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">error</span>
              <span>Lỗi tải dữ liệu so sánh phiên bản: {formatUiError(error)}</span>
            </div>
            <button
              type="button"
              onClick={() => void loadChanges(true)}
              className="font-semibold underline hover:text-error/80 ml-3"
            >
              Thử lại
            </button>
          </div>
        )}

        {/* Prompt when in custom mode but no base version is selected */}
        {isCustomBasePendingSelection && (
          <div className="p-12 text-center text-xs text-on-surface-variant">
            <span className="material-symbols-outlined text-[36px] text-primary/70 mb-2">compare</span>
            <div className="font-semibold text-on-surface text-sm">Vui lòng chọn phiên bản để đối chiếu</div>
            <p className="mt-1 max-w-sm mx-auto">
              Chọn một phiên bản từ danh sách thả xuống ở thanh công cụ phía trên để xem các điểm khác biệt so với phiên bản hiện tại.
            </p>
          </div>
        )}

        {/* Loading spinner */}
        {loading && (
          <div className="p-12 text-center text-xs text-on-surface-variant">
            <div className="mx-auto mb-2 h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Đang tải dữ liệu so sánh phiên bản...
          </div>
        )}

        {/* Empty states */}
        {!loading && !error && !isCustomBasePendingSelection && entries.length === 0 && (
          <div className="p-12 text-center text-xs text-on-surface-variant">
            {changeTypeFilter !== 'all' || fieldFilter !== 'all' || debouncedSearch || dateFrom || dateTo ? (
              <>
                <div className="text-sm font-semibold text-on-surface mb-1">Không có kết quả phù hợp</div>
                Không tìm thấy thay đổi nào phù hợp với điều kiện lọc hiện tại.
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="rounded-lg bg-surface-variant/40 px-3 py-1 text-xs font-semibold text-primary hover:bg-surface-variant/70"
                  >
                    Xóa toàn bộ bộ lọc
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-on-surface mb-1">Không có thay đổi</div>
                Hai phiên bản này có dữ liệu giống hệt nhau hoặc phiên bản không có biến động kế hoạch.
              </>
            )}
          </div>
        )}

        {/* Diff Entries Table */}
        {!loading && !isCustomBasePendingSelection && entries.length > 0 && (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-surface-variant/50 backdrop-blur border-b border-outline-variant text-[11px] font-bold text-on-surface-variant uppercase z-10">
              <tr>
                <th className="py-2 px-3 w-24">Loại</th>
                <th className="py-2 px-3 w-40">Chuyến bay</th>
                <th className="py-2 px-3 w-56">{viewMode === 'groups' ? 'Khoảng ngày' : 'Ngày bay'}</th>
                <th className="py-2 px-3">Nội dung thay đổi</th>
                <th className="py-2 px-3 w-16 text-center">Chi tiết</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {entries.map((row, idx) => {
                const rowKey = `${row.group_key || row.entry_index}_${idx}`;
                const isExpanded = Boolean(expandedRows[rowKey]);
                const showUnchanged = Boolean(showUnchangedFields[rowKey]);

                // Flight descriptor / diff summary
                const flightNum = formatFlightNumber(row.airline, row.flight_number);
                const sideLabel = row.side === 'ARR' ? 'Đến' : 'Đi';

                // Format dates
                const dayRanges = formatDayRanges(row.dates || (row.operational_date ? [row.operational_date] : []));
                const datesDisplay =
                  dayRanges.join(', ') ||
                  (row.operational_date ? formatDateDisplay(row.operational_date) : '—');

                return (
                  <tr key={rowKey} className="group hover:bg-surface-variant/15 transition-colors">
                    <td colSpan={5} className="p-0">
                      {/* Compact main row */}
                      <div className="flex items-center px-3 py-2">
                        {/* Change Type Badge */}
                        <div className="w-24 flex-none">
                          <span
                            className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                              row.change_type === 'added'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : row.change_type === 'removed'
                                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                            }`}
                          >
                            {row.change_type === 'added'
                              ? '+ Thêm mới'
                              : row.change_type === 'removed'
                              ? '- Xóa'
                              : '~ Điều chỉnh'}
                          </span>
                        </div>

                        {/* Flight & Side */}
                        <div className="w-40 flex-none flex items-center gap-1.5 font-mono">
                          <span className="font-bold text-primary">{flightNum}</span>
                          <span className="text-[10px] rounded bg-surface-variant/40 px-1 py-0.2 text-on-surface-variant">
                            {sideLabel}
                          </span>
                        </div>

                        {/* Dates */}
                        <div className="w-56 flex-none pr-3">
                          <div className="font-mono text-[11px] text-on-surface line-clamp-1" title={datesDisplay}>
                            {datesDisplay}
                          </div>
                          {viewMode === 'groups' && row.occurrence_count > 1 && (
                            <div className="text-[10px] text-on-surface-variant">
                              {row.occurrence_count} ngày bay
                            </div>
                          )}
                        </div>

                        {/* Content summary */}
                        <div className="flex-1 min-w-0 pr-3">
                          {row.change_type === 'added' ? (
                            <span className="text-on-surface font-medium">
                              {formatFlightDescriptor(row.after_state)}
                            </span>
                          ) : row.change_type === 'removed' ? (
                            <span className="text-on-surface-variant line-through opacity-80">
                              {formatFlightDescriptor(row.before_state)}
                            </span>
                          ) : (
                            <span className="text-on-surface font-medium">
                              {formatDiffSummary(row.before_state, row.after_state, row.changed_fields)}
                            </span>
                          )}
                        </div>

                        {/* Expand/Collapse Button */}
                        <div className="w-16 flex-none text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedRows((prev) => ({
                                ...prev,
                                [rowKey]: !prev[rowKey],
                              }))
                            }
                            className="rounded p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-variant/40"
                            title={isExpanded ? 'Thu gọn' : 'Xem chi tiết'}
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              {isExpanded ? 'expand_less' : 'expand_more'}
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Expanded View */}
                      {isExpanded && (
                        <div className="bg-surface-variant/10 border-t border-b border-outline-variant/40 px-6 py-4 space-y-4">
                          {/* In Groups view: allow inspecting exact days */}
                          {viewMode === 'groups' && row.dates && row.dates.length > 0 && (
                            <div className="rounded-lg border border-outline-variant bg-surface p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-on-surface">
                                  Danh sách ngày áp dụng ({row.dates.length} ngày)
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleToggleGroupDays(row.group_key)}
                                  className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
                                >
                                  <span>
                                    {expandedGroupDaysView[row.group_key]
                                      ? 'Ẩn chi tiết từng ngày'
                                      : 'Tải chi tiết từng ngày'}
                                  </span>
                                  <span className="material-symbols-outlined text-[14px]">
                                    {expandedGroupDaysView[row.group_key] ? 'unfold_less' : 'unfold_more'}
                                  </span>
                                </button>
                              </div>

                              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                                {row.dates.map((d) => (
                                  <span
                                    key={d}
                                    className="font-mono text-[10px] bg-surface-variant/40 px-2 py-0.5 rounded text-on-surface"
                                  >
                                    {formatDateDisplay(d)}
                                  </span>
                                ))}
                              </div>

                              {/* On-demand Day expansion table for this group with pagination & error handling */}
                              {expandedGroupDaysView[row.group_key] && (
                                <div className="mt-3 pt-3 border-t border-outline-variant space-y-2">
                                  {groupDaysMap[row.group_key]?.loading && (
                                    <div className="py-3 text-center text-xs text-on-surface-variant">
                                      <div className="mx-auto mb-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                                      Đang tải chi tiết từng ngày bay...
                                    </div>
                                  )}

                                  {groupDaysMap[row.group_key]?.error && (
                                    <div className="rounded bg-error/10 border border-error/20 p-2 text-xs text-error flex items-center justify-between">
                                      <span>Lỗi tải ngày bay: {formatUiError(groupDaysMap[row.group_key].error)}</span>
                                      <button
                                        type="button"
                                        onClick={() => void loadGroupDays(row.group_key, true)}
                                        className="font-semibold underline ml-2 hover:text-error/80"
                                      >
                                        Thử lại
                                      </button>
                                    </div>
                                  )}

                                  {!groupDaysMap[row.group_key]?.loading &&
                                    groupDaysMap[row.group_key]?.entries &&
                                    groupDaysMap[row.group_key].entries.length > 0 && (
                                      <div className="space-y-2">
                                        <div className="max-h-48 overflow-y-auto border border-outline-variant rounded">
                                          <table className="w-full text-[11px]">
                                            <thead className="bg-surface-variant/30 sticky top-0 font-semibold text-on-surface-variant">
                                              <tr>
                                                <th className="py-1 px-2 text-left">Ngày</th>
                                                <th className="py-1 px-2 text-left">Chuyến bay</th>
                                                <th className="py-1 px-2 text-left">Trạng thái trước</th>
                                                <th className="py-1 px-2 text-left">Trạng thái sau</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-outline-variant/30 font-mono">
                                              {groupDaysMap[row.group_key].entries.map((dayRow) => {
                                                const daySide = dayRow.side === 'ARR' ? 'Đến' : 'Đi';
                                                return (
                                                  <tr key={dayRow.entry_index}>
                                                    <td className="py-1 px-2 font-bold text-primary">
                                                      {formatDateDisplay(dayRow.operational_date)}
                                                    </td>
                                                    <td className="py-1 px-2 text-on-surface">
                                                      {formatFlightNumber(dayRow.airline, dayRow.flight_number)}{' '}
                                                      <span className="text-[10px] text-on-surface-variant">
                                                        ({daySide})
                                                      </span>
                                                    </td>
                                                    <td className="py-1 px-2 text-on-surface-variant font-sans">
                                                      {formatFlightDescriptor(dayRow.before_state)}
                                                    </td>
                                                    <td className="py-1 px-2 text-on-surface font-sans">
                                                      {formatFlightDescriptor(dayRow.after_state)}
                                                    </td>
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>

                                        {groupDaysMap[row.group_key].hasMore && (
                                          <div className="text-center pt-1">
                                            <button
                                              type="button"
                                              onClick={() => void loadGroupDays(row.group_key, false)}
                                              disabled={groupDaysMap[row.group_key].loadingMore}
                                              className="rounded border border-outline-variant px-3 py-1 text-[11px] font-semibold text-primary hover:bg-surface-variant/40 disabled:opacity-50"
                                            >
                                              {groupDaysMap[row.group_key].loadingMore
                                                ? 'Đang tải...'
                                                : 'Tải thêm ngày bay'}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Business Before/After Comparison Table */}
                          <div className="rounded-lg border border-outline-variant bg-surface p-3 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-on-surface">
                                Bảng so sánh thông tin kế hoạch
                              </span>
                              <label className="flex items-center gap-1.5 text-xs text-on-surface-variant cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={showUnchanged}
                                  onChange={(e) =>
                                    setShowUnchangedFields((prev) => ({
                                      ...prev,
                                      [rowKey]: e.target.checked,
                                    }))
                                  }
                                  className="rounded border-outline-variant text-primary focus:ring-primary"
                                />
                                <span>Hiển thị trường không đổi</span>
                              </label>
                            </div>

                            <table className="w-full text-xs border-collapse">
                              <thead className="bg-surface-variant/30 text-[11px] font-semibold text-on-surface-variant">
                                <tr>
                                  <th className="py-1.5 px-3 text-left w-36">Trường dữ liệu</th>
                                  <th className="py-1.5 px-3 text-left">Bản trước</th>
                                  <th className="py-1.5 px-3 text-left">Bản sau</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-outline-variant/20">
                                {CANONICAL_FIELD_DEFS.map((def) => {
                                  const bVal = getCanonicalValue(row.before_state, def);
                                  const aVal = getCanonicalValue(row.after_state, def);
                                  const isEquiv = areValuesEquivalent(bVal, aVal, def.key);

                                  if (isEquiv && !showUnchanged) return null;

                                  const bStr = formatSingleValue(bVal, def.key);
                                  const aStr = formatSingleValue(aVal, def.key);

                                  return (
                                    <tr
                                      key={def.key}
                                      className={isEquiv ? 'opacity-60' : 'bg-amber-500/5 font-medium'}
                                    >
                                      <td className="py-1.5 px-3 font-medium text-on-surface-variant">
                                        {def.label}
                                      </td>
                                      <td className="py-1.5 px-3 text-on-surface-variant font-mono">{bStr}</td>
                                      <td
                                        className={`py-1.5 px-3 font-mono ${
                                          isEquiv ? 'text-on-surface-variant' : 'text-on-surface font-bold'
                                        }`}
                                      >
                                        {aStr}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Technical Disclosure (Closed by default) */}
                          <details className="rounded-lg border border-outline-variant bg-surface p-3 text-xs">
                            <summary className="cursor-pointer font-bold text-on-surface-variant hover:text-on-surface select-none">
                              Chi tiết dữ liệu gốc
                            </summary>
                            <div className="mt-3 space-y-3 font-mono text-[11px]">
                              <div>
                                <span className="font-sans font-semibold text-on-surface-variant">
                                  Các trường thay đổi:
                                </span>
                                <div className="mt-1 bg-surface-variant/30 rounded p-2 text-on-surface">
                                  {row.changed_fields && row.changed_fields.length > 0
                                    ? row.changed_fields.map((f) => formatUiFieldLabel(f)).join(', ')
                                    : 'Không có'}
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                  <span className="font-sans font-semibold text-on-surface-variant">
                                    Dữ liệu trước thay đổi:
                                  </span>
                                  <pre className="mt-1 bg-surface-variant/20 rounded p-2.5 max-h-48 overflow-auto text-[10px]">
                                    {formatUiRecord(row.before_state)}
                                  </pre>
                                </div>
                                <div>
                                  <span className="font-sans font-semibold text-on-surface-variant">
                                    Dữ liệu sau thay đổi:
                                  </span>
                                  <pre className="mt-1 bg-surface-variant/20 rounded p-2.5 max-h-48 overflow-auto text-[10px]">
                                    {formatUiRecord(row.after_state)}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          </details>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Load More Button */}
        {hasMore && !loading && (
          <div className="p-4 text-center border-t border-outline-variant bg-surface">
            <button
              type="button"
              onClick={() => void loadChanges(false)}
              disabled={loadingMore || disabled}
              className="rounded-lg border border-outline-variant px-5 py-2 text-xs font-semibold text-primary hover:bg-surface-variant/50 disabled:opacity-50"
            >
              {loadingMore ? 'Đang tải thêm...' : 'Tải thêm mục thay đổi'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
