'use client';

import { useEffect, useMemo, useState } from 'react';
import { getOrCreateAuditSessionId, type AuditDeltaItem, type AuditLogEntry, type AuditSession } from '@/lib/auditLog';
import {
  readAuditDeltaState,
  readAuditEntriesState,
  readAuditSessionsState,
  revalidateAuditDeltas,
  revalidateAuditEntries,
  revalidateAuditSessions,
} from '@/lib/auditReadModel';
import { buildLoadProgress } from '@/lib/importProgress';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from '@/lib/operatorSessionCacheRegistry';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import {
  formatUiError,
  formatUiFieldLabel,
  formatUiValue,
  formatUiRecord,
} from '@/lib/uiDisplayText';

const AUDIT_MODULE_LABELS: Record<string, string> = {
  seasonal: 'Lịch mùa',
  detailed: 'Lịch chi tiết',
  daily: 'Lịch ngày',
  checkin: 'Phân bổ quầy',
  gate: 'Phân bổ cửa',
  settings: 'Cấu hình',
  sync: 'Đồng bộ',
  import: 'Nhập dữ liệu',
};

const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  'user-action': 'Thao tác người dùng',
  sync: 'Đồng bộ',
  import: 'Nhập dữ liệu',
  settings: 'Cấu hình',
};

const AUDIT_FIELD_LABELS: Record<string, string> = {
  record: 'Bản ghi chuyến bay',
  modification: 'Thông tin điều chỉnh',
  historyEntry: 'Mục lịch sử thao tác',
  row: 'Dòng dữ liệu',
  settings: 'Cài đặt cấu hình',
};

function formatAuditFieldLabel(field: string): string {
  if (!field) return '-';
  if (AUDIT_FIELD_LABELS[field]) return AUDIT_FIELD_LABELS[field];
  const uiLabel = formatUiFieldLabel(field);
  return uiLabel !== 'Thông tin khác' ? uiLabel : field;
}

function formatAuditTargetLabel(label: string): string {
  if (!label) return '-';
  if (label === 'Operational settings') return 'Cấu hình vận hành';
  const sourceRowMatch = /^Source row (\d+)$/i.exec(label);
  if (sourceRowMatch) return `Dòng nguồn ${sourceRowMatch[1]}`;
  return label;
}

function formatAuditOperation(operation: string): string {
  if (!operation || typeof operation !== 'string') return '-';
  const trimmed = operation.trim();
  if (!trimmed) return '-';

  // Specific static operations
  if (/^saved operational settings$/i.test(trimmed)) {
    return 'Lưu cấu hình vận hành';
  }
  if (/^draft pattern change$/i.test(trimmed)) {
    return 'Thay đổi mẫu kế hoạch bản nháp';
  }
  if (/^move gate$/i.test(trimmed)) {
    return 'Chuyển cửa khởi hành';
  }
  if (/^modified route$/i.test(trimmed)) {
    return 'Điều chỉnh đường bay';
  }
  if (/^batch check-in allocation updates$/i.test(trimmed)) {
    return 'Cập nhật phân bổ quầy hàng loạt';
  }

  // Undid ...
  const undidMatch = /^undid\s+(.+)$/i.exec(trimmed);
  if (undidMatch) {
    return `Đã hoàn tác: ${formatAuditOperation(undidMatch[1])}`;
  }

  // Imported season ...
  const importMatch = /^imported season ([^:]+):\s*(\d+)\s*imported records$/i.exec(trimmed);
  if (importMatch) {
    return `Nhập lịch mùa ${importMatch[1]}: ${importMatch[2]} bản ghi`;
  }
  const fullReplaceMatch = /^full replace repair import for season ([^:]+):\s*(\d+)\s*imported records$/i.exec(trimmed);
  if (fullReplaceMatch) {
    return `Nhập sửa chữa thay thế toàn bộ cho mùa ${fullReplaceMatch[1]}: ${fullReplaceMatch[2]} bản ghi`;
  }
  const dailyImportMatch = /^daily import:\s*updated\s*(\d+),\s*inserted\s*(\d+),\s*deleted\s*(\d+)$/i.exec(trimmed);
  if (dailyImportMatch) {
    return `Nhập lịch ngày: cập nhật ${dailyImportMatch[1]}, thêm mới ${dailyImportMatch[2]}, xóa ${dailyImportMatch[3]}`;
  }

  // Unlinked ...
  const unlinkedForMatch = /^unlinked\s+(\d+)\s+flight occurrence\(s\)\s+for\s+(.+)$/i.exec(trimmed);
  if (unlinkedForMatch) {
    return `Hủy liên kết ${unlinkedForMatch[1]} lượt bay của ${unlinkedForMatch[2]}`;
  }
  const unlinkedMatch = /^unlinked\s+(\d+)\s+flight occurrence\(s\)$/i.exec(trimmed);
  if (unlinkedMatch) {
    return `Hủy liên kết ${unlinkedMatch[1]} lượt bay`;
  }

  // Linked ...
  const linkedTypeMatch = /^linked\s+(\d+)\s+(overnight|same-day)\s+flight occurrence\(s\)$/i.exec(trimmed);
  if (linkedTypeMatch) {
    const typeLabel = linkedTypeMatch[2].toLowerCase() === 'overnight' ? 'qua đêm' : 'trong ngày';
    return `Liên kết ${linkedTypeMatch[1]} lượt bay (${typeLabel})`;
  }
  const linkedMatch = /^linked\s+(\d+)\s+flight occurrence\(s\)$/i.exec(trimmed);
  if (linkedMatch) {
    return `Liên kết ${linkedMatch[1]} lượt bay`;
  }

  // Added / Modified / Deleted flights
  const addedMatch = /^added\s+(\d+)\s+(?:flight occurrence\(s\)|flights)$/i.exec(trimmed);
  if (addedMatch) {
    return `Thêm ${addedMatch[1]} chuyến bay`;
  }
  const modMatch = /^modified\s+(\d+)\s+flight(?:s)?$/i.exec(trimmed);
  if (modMatch) {
    return `Điều chỉnh ${modMatch[1]} chuyến bay`;
  }
  const delForMatch = /^deleted\s+(\d+)\s+flight occurrence\(s\)\s+for\s+(.+)$/i.exec(trimmed);
  if (delForMatch) {
    return `Đã xóa ${delForMatch[1]} lượt bay của ${delForMatch[2]}`;
  }
  const delMatch = /^deleted\s+(\d+)\s+flight\(s\)$/i.exec(trimmed);
  if (delMatch) {
    return `Đã xóa ${delMatch[1]} chuyến bay`;
  }

  // Allocated check-in or gate
  const allocCounterMatch = /^allocated\s+(.+)\s+to counter\s+(.+)$/i.exec(trimmed);
  if (allocCounterMatch) {
    return `Phân bổ ${allocCounterMatch[1]} vào quầy ${allocCounterMatch[2]}`;
  }
  const allocGateMatch = /^allocated\s+(.+)\s+to gate\s+(.+)$/i.exec(trimmed);
  if (allocGateMatch) {
    return `Phân bổ ${allocGateMatch[1]} vào cửa ${allocGateMatch[2]}`;
  }
  const movedCheckinMatch = /^moved\s+(.+)\s+check-in allocation$/i.exec(trimmed);
  if (movedCheckinMatch) {
    return `Di chuyển phân bổ quầy ${movedCheckinMatch[1]}`;
  }
  const movedGateMatch = /^moved\s+(.+)\s+gate allocation$/i.exec(trimmed);
  if (movedGateMatch) {
    return `Di chuyển phân bổ cửa ${movedGateMatch[1]}`;
  }

  // Sync ...
  const syncMatch = /^sync\s+(synced|noop|conflict|failed)\s+for\s+([^:]+):\s*(.*)$/i.exec(trimmed);
  if (syncMatch) {
    const statusMap: Record<string, string> = {
      synced: 'thành công',
      noop: 'không thay đổi',
      conflict: 'xung đột',
      failed: 'thất bại',
    };
    const statusLabel = statusMap[syncMatch[1].toLowerCase()] ?? syncMatch[1];
    return `Đồng bộ ${statusLabel} cho ${syncMatch[2]}: ${syncMatch[3]}`;
  }

  // Published / Restored version
  const publishedVersionMatch = /^published version\s+(.+)$/i.exec(trimmed);
  if (publishedVersionMatch) {
    return `Công bố phiên bản ${publishedVersionMatch[1]}`;
  }
  const restoredVersionMatch = /^restored version\s+(.+)$/i.exec(trimmed);
  if (restoredVersionMatch) {
    return `Khôi phục phiên bản ${restoredVersionMatch[1]}`;
  }

  return trimmed;
}

type AuditFilters = {
  season: string;
  module: string;
  category: string;
  search: string;
};

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function matchesFilter(entry: AuditLogEntry, filters: AuditFilters): boolean {
  if (filters.season && entry.seasonCode !== filters.season && entry.seasonId !== filters.season) return false;
  if (filters.module && entry.module !== filters.module) return false;
  if (filters.category && entry.category !== filters.category) return false;
  const query = filters.search.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    entry.operation,
    entry.module,
    entry.category,
    entry.seasonCode,
    entry.seasonId,
    ...entry.targetFlightLabels,
    ...entry.targetFlightIds,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function formatValue(value: unknown, field?: string): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object' && value !== null) {
    return formatUiRecord(value);
  }
  return formatUiValue(value, field);
}

export default function AuditLogPage() {
  const [currentSessionId] = useState(() => getOrCreateAuditSessionId());
  const initialSessionsState = readAuditSessionsState();
  const [sessions, setSessions] = useState<AuditSession[]>(() => initialSessionsState.snapshot ?? []);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const initialSessions = initialSessionsState.snapshot ?? [];
    return initialSessions.some((session) => session.id === currentSessionId)
      ? currentSessionId
      : initialSessions[0]?.id ?? currentSessionId;
  });
  const [entries, setEntries] = useState<AuditLogEntry[]>(() => readAuditEntriesState(selectedSessionId ?? currentSessionId).snapshot ?? []);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [expandedDeltas, setExpandedDeltas] = useState<Record<string, AuditDeltaItem[]>>({});
  const [loadingSessions, setLoadingSessions] = useState(initialSessionsState.snapshot === null);
  const [loadingEntries, setLoadingEntries] = useState(() => readAuditEntriesState(selectedSessionId ?? currentSessionId).snapshot === null);
  const [filters, setFilters] = useState<AuditFilters>({
    season: '',
    module: '',
    category: '',
    search: '',
  });

  useEffect(() => {
    let cancelled = false;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    const snapshotState = readAuditSessionsState();

    async function loadSessions(): Promise<void> {
      await Promise.resolve();
      if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      if (snapshotState.snapshot) setSessions(snapshotState.snapshot);
      if (!snapshotState.shouldRevalidate) {
        setLoadingSessions(false);
        return;
      }
      setLoadingSessions(snapshotState.snapshot === null);
      try {
        const nextSessions = await revalidateAuditSessions();
        if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
        setSessions(nextSessions);
        setSelectedSessionId((current) => {
          if (current) return current;
          if (nextSessions.some((session) => session.id === currentSessionId)) return currentSessionId;
          return nextSessions[0]?.id ?? currentSessionId;
        });
      } finally {
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setLoadingSessions(false);
      }
    }
    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    let cancelled = false;
    const sessionId = selectedSessionId;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    const snapshotState = readAuditEntriesState(sessionId);

    async function loadEntries(): Promise<void> {
      await Promise.resolve();
      if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      if (snapshotState.snapshot) setEntries(snapshotState.snapshot);
      if (!snapshotState.shouldRevalidate) {
        setLoadingEntries(false);
        return;
      }
      setLoadingEntries(snapshotState.snapshot === null);
      try {
        const nextEntries = await revalidateAuditEntries(sessionId);
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setEntries(nextEntries);
      } finally {
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setLoadingEntries(false);
      }
    }

    void loadEntries();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  const filteredEntries = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filters)),
    [entries, filters]
  );

  const seasonOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.seasonCode ?? entry.seasonId).filter(Boolean) as string[])).sort(),
    [entries]
  );

  const moduleOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.module))).sort(),
    [entries]
  );

  const categoryOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.category))).sort(),
    [entries]
  );

  async function toggleEntry(entry: AuditLogEntry): Promise<void> {
    if (expandedEntryId === entry.id) {
      setExpandedEntryId(null);
      return;
    }

    setExpandedEntryId(entry.id);
    if (expandedDeltas[entry.id] || !selectedSessionId) return;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    const cached = readAuditDeltaState(selectedSessionId, entry.id);
    if (cached.snapshot) {
      setExpandedDeltas((current) => ({ ...current, [entry.id]: cached.snapshot ?? [] }));
      if (!cached.shouldRevalidate) return;
    }
    const deltas = await revalidateAuditDeltas(selectedSessionId, entry);
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    setExpandedDeltas((current) => ({
      ...current,
      [entry.id]: deltas,
    }));
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId);

  return (
    <main className="flex h-dvh min-w-0 overflow-hidden bg-slate-100 p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100 sm:p-4 lg:p-6">
      <div className="mx-auto flex h-full w-full max-w-[1800px] min-w-0 flex-col gap-4 lg:gap-5">
        <header className="flex flex-none flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Lịch sử thao tác</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Nhật ký theo phiên ghi nhận các thay đổi dữ liệu và đồng bộ.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!selectedSessionId) return;
              const operatorSessionEpoch = getOperatorSessionEpoch();
              setLoadingEntries(entries.length === 0);
              void revalidateAuditEntries(selectedSessionId, { force: true }).then((nextEntries) => {
                if (isOperatorSessionEpochCurrent(operatorSessionEpoch)) setEntries(nextEntries);
              }).finally(() => {
                if (isOperatorSessionEpochCurrent(operatorSessionEpoch)) setLoadingEntries(false);
              });
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Làm mới
          </button>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] lg:gap-5">
          <section
            className="min-w-0 overflow-auto rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            aria-label="Phiên thao tác"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Phiên thao tác</h2>
              {loadingSessions && <span className="text-xs text-slate-400">Đang tải phiên thao tác...</span>}
            </div>
            <div className="space-y-2">
              {sessions.length === 0 && loadingSessions && (
                <LoadingStatusPanel
                  progress={buildLoadProgress('Đang tải phiên thao tác', 40, 'Đang lấy các phiên đã lưu', { indeterminate: true })}
                  className="min-h-[180px] rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                  icon="history"
                />
              )}
              {sessions.length === 0 && !loadingSessions && (
                <div className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Chưa có phiên thao tác nào được lưu.
                </div>
              )}
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                const isSelected = session.id === selectedSessionId;
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full rounded-md border p-3 text-left text-sm transition-colors ${
                      isSelected
                        ? 'border-primary bg-blue-50 text-blue-950 dark:bg-blue-950/40 dark:text-blue-100'
                        : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{isCurrent ? 'Phiên hiện tại' : session.id}</span>
                      {isCurrent && <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-on-primary">HIỆN HÀNH</span>}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatTimestamp(session.lastSeenAt)}</div>
                    <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                      {session.actor.displayName ?? session.actor.email ?? 'Ẩn danh'}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="border-b border-slate-200 p-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">Bản ghi thao tác</h2>
                  <p className="max-w-full truncate text-sm text-slate-500 dark:text-slate-400">
                    {selectedSession ? selectedSession.id : selectedSessionId ?? 'Chưa chọn phiên'}
                  </p>
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {filteredEntries.length} / {entries.length} bản ghi
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <input
                  value={filters.search}
                  onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                  placeholder="Tìm thao tác hoặc chuyến bay"
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
                <select
                  value={filters.season}
                  onChange={(event) => setFilters((current) => ({ ...current, season: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">Tất cả mùa</option>
                  {seasonOptions.map((season) => <option key={season} value={season}>{season}</option>)}
                </select>
                <select
                  value={filters.module}
                  onChange={(event) => setFilters((current) => ({ ...current, module: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">Tất cả phân hệ</option>
                  {moduleOptions.map((module) => <option key={module} value={module}>{AUDIT_MODULE_LABELS[module] ?? (formatUiFieldLabel(module) !== 'Thông tin khác' ? formatUiFieldLabel(module) : module)}</option>)}
                </select>
                <select
                  value={filters.category}
                  onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">Tất cả danh mục</option>
                  {categoryOptions.map((category) => <option key={category} value={category}>{AUDIT_CATEGORY_LABELS[category] ?? (formatUiFieldLabel(category) !== 'Thông tin khác' ? formatUiFieldLabel(category) : category)}</option>)}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                  <tr>
                    <th className="w-12 border-b border-slate-200 px-3 py-2 dark:border-slate-800" />
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Thời gian</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Phân hệ</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Danh mục</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Thao tác</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Chuyến bay</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Biến động</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingEntries && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4">
                        <LoadingStatusPanel
                          progress={buildLoadProgress('Đang tải bản ghi thao tác', 55, 'Đang lấy dữ liệu biến động', { indeterminate: true })}
                          className="min-h-[180px]"
                          icon="history"
                        />
                      </td>
                    </tr>
                  )}
                  {!loadingEntries && filteredEntries.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">Không có bản ghi thao tác nào khớp với bộ lọc hiện tại.</td>
                    </tr>
                  )}
                  {filteredEntries.map((entry) => {
                    const isExpanded = expandedEntryId === entry.id;
                    const deltas = expandedDeltas[entry.id] ?? [];
                    return (
                      <tr key={entry.id} className="align-top odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-950">
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <button
                            type="button"
                            onClick={() => void toggleEntry(entry)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                            aria-label={isExpanded ? 'Thu gọn chi tiết biến động' : 'Xem chi tiết biến động'}
                          >
                            <span className="material-symbols-outlined text-[18px]">{isExpanded ? 'expand_less' : 'expand_more'}</span>
                          </button>
                        </td>
                        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3 dark:border-slate-800">{formatTimestamp(entry.timestamp)}</td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">{AUDIT_MODULE_LABELS[entry.module] ?? (formatUiFieldLabel(entry.module) !== 'Thông tin khác' ? formatUiFieldLabel(entry.module) : entry.module)}</td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">{AUDIT_CATEGORY_LABELS[entry.category] ?? (formatUiFieldLabel(entry.category) !== 'Thông tin khác' ? formatUiFieldLabel(entry.category) : entry.category)}</td>
                        <td className="max-w-xl border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <div className="font-medium">{formatAuditOperation(entry.operation)}</div>
                          {entry.syncDelta && (
                            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              Thêm mới {entry.syncDelta.flightsAdded}, xóa {entry.syncDelta.flightsRemoved}, điều chỉnh {entry.syncDelta.flightsModified}; giai đoạn {entry.syncDelta.affectedPeriod.from ?? '-'} đến {entry.syncDelta.affectedPeriod.to ?? '-'}
                            </div>
                          )}
                          {isExpanded && (
                            <div className="mt-3 max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
                              <table className="min-w-full text-xs">
                                <thead className="bg-slate-100 text-left text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                                  <tr>
                                    <th className="px-2 py-1">Đối tượng</th>
                                    <th className="px-2 py-1">Trường thông tin</th>
                                    <th className="px-2 py-1">Trước</th>
                                    <th className="px-2 py-1">Sau</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {deltas.length === 0 && (
                                    <tr>
                                      <td colSpan={4} className="px-2 py-3 text-center text-slate-500">Không có thông tin biến động chi tiết.</td>
                                    </tr>
                                  )}
                                  {deltas.map((delta, index) => (
                                    <tr key={`${entry.id}-${delta.targetId}-${delta.field}-${index}`} className="border-t border-slate-200 dark:border-slate-800">
                                      <td className="max-w-[180px] truncate px-2 py-1">{formatAuditTargetLabel(delta.targetLabel)}</td>
                                      <td className="px-2 py-1">{formatAuditFieldLabel(delta.field)}</td>
                                      <td className="max-w-[260px] truncate px-2 py-1">{formatValue(delta.before, delta.field)}</td>
                                      <td className="max-w-[260px] truncate px-2 py-1">{formatValue(delta.after, delta.field)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <div className="flex max-w-[240px] flex-wrap gap-1">
                            {entry.targetFlightLabels.length === 0 && <span className="text-slate-400">-</span>}
                            {entry.targetFlightLabels.slice(0, 6).map((label) => (
                              <span key={label} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium dark:bg-slate-800">{label}</span>
                            ))}
                            {entry.targetFlightLabels.length > 6 && <span className="text-xs text-slate-500">+{entry.targetFlightLabels.length - 6}</span>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          {(entry.deltaChunkCount ?? 0) > 0 ? `${entry.deltaChunkCount} phân đoạn` : `${entry.deltas.length} mục`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
