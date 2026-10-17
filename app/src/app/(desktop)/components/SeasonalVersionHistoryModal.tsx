'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  getSeasonalPublishVersionsV1,
  getSeasonalPublishedSnapshotPageV1,
  getSeasonalPublishedExportSnapshotV1,
  restoreSeasonalPublishedDraftV1,
} from '@/lib/remoteStore';
import { seasonalDraftExportSnapshotToFlightRecords } from '@/lib/seasonalPlanningSaveManager';
import { buildCanonicalSeasonalRows, exportCanonicalSeasonalRowsToExcel } from '@/lib/canonicalSeasonalRows';
import { validateFlightLegsForSeasonalExport } from '@/lib/exporter';
import { saveExportBlob } from '@/lib/exportSave';
import { formatFlightNumber } from '@/lib/seasonalDiffFormatters';
import { formatUiError, formatUiFieldLabel, formatUiRecord, formatUiValue } from '@/lib/uiDisplayText';
import SeasonalVersionChangesView from './SeasonalVersionChangesView';
import {
  clearSeasonalRestoreAttempt,
  loadSeasonalRestoreAttempt,
  markSeasonalRestoreAttemptStatus,
  persistSeasonalRestoreAttempt,
  setSeasonalRestoreExecuting,
  subscribeToSeasonalRestoreState,
  type SeasonalRestoreAttemptPayload,
} from '@/lib/seasonalRestoreJournal';
import { getOperatorSessionEpoch } from '@/lib/operatorSessionCacheRegistry';
import { getSynchronousOperatorUserId } from '@/lib/operationalScheduleAdapter';
import { useExportNotifications } from './ExportNotificationProvider';
import type {
  SeasonalPublishVersionSummary,
  SeasonalDraftRecord,
  SeasonalDraftRestoreResult,
} from '@/lib/seasonalPlanningContract';

interface SeasonalVersionHistoryModalProps {
  isOpen: boolean;
  seasonId: string;
  seasonCode: string;
  onClose: () => void;
  initialVersion?: SeasonalPublishVersionSummary;
  readOnly?: boolean;
  isRestricted?: boolean;
  restrictedReason?: string;
  currentDraftRevision?: string | number | null;
  currentDraftEpoch?: string | null;
  onBeginRestore?: () => Promise<boolean> | boolean;
  onFinishRestore?: () => void;
  onDraftRestored: (receipt?: SeasonalDraftRestoreResult) => Promise<void> | void;
}

function isDeterministicDraftConflictError(err: unknown): boolean {
  if (!err) return false;
  const errorObj = err as { code?: string; message?: string; details?: string };
  const code = String(errorObj.code ?? '');
  const message = String(errorObj.message ?? err);
  return (
    code === '40001' ||
    message.includes('Draft snapshot changed') ||
    message.includes('Draft snapshot required') ||
    message.includes('Request ID reused with different payload')
  );
}

export default function SeasonalVersionHistoryModal({
  isOpen,
  seasonId,
  seasonCode,
  onClose,
  initialVersion,
  readOnly = false,
  isRestricted = false,
  restrictedReason,
  currentDraftRevision,
  currentDraftEpoch,
  onBeginRestore,
  onFinishRestore,
  onDraftRestored,
}: SeasonalVersionHistoryModalProps) {
  const { notifyExportCompleted } = useExportNotifications();

  // Version list state
  const [versions, setVersions] = useState<SeasonalPublishVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionsHasMore, setVersionsHasMore] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<SeasonalPublishVersionSummary | null>(initialVersion ?? null);
  const nextSequenceRef = useRef<string | null>(null);

  // Active tab inside selected version
  const [activeTab, setActiveTab] = useState<'snapshot' | 'diff'>('snapshot');

  // Snapshot tab state
  const [snapshotFlights, setSnapshotFlights] = useState<SeasonalDraftRecord[]>([]);
  const [snapshotTotalCount, setSnapshotTotalCount] = useState<number>(0);
  const [snapshotHasMore, setSnapshotHasMore] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const snapshotNextDraftIdRef = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterDate, setFilterDate] = useState('');


  // Action states
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<SeasonalRestoreAttemptPayload | null>(null);

  // Independent generations for cancellation & race prevention
  const versionsGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  const restoreGeneration = useRef(0);
  const sessionEpochRef = useRef(getOperatorSessionEpoch());
  // ANY valid current-owner pending journal (executing, unresolved, or committed-awaiting-reload) blocks close/selection/navigation
  const isRestorePending = pendingRestore !== null;
  const isRestoreCommitted = pendingRestore !== null && pendingRestore.status === 'committed';
  const isRestoreUnresolved = pendingRestore !== null && pendingRestore.status !== 'committed';
  const isRestoreBlocked = isRestoring || isRestorePending;

  // Prevent unload while restore is executing or pending completion/reload
  useEffect(() => {
    if (!isRestoreBlocked) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRestoreBlocked]);

  // Rehydrate persisted unresolved restore attempt on mount, season change, or operator session change
  useEffect(() => {
    const syncRestoreFromJournal = () => {
      if (!isOpen || !seasonId) return;
      const currentEpoch = getOperatorSessionEpoch();
      const currentOperator = getSynchronousOperatorUserId();
      const epochChanged = currentEpoch !== sessionEpochRef.current;

      if (epochChanged) {
        sessionEpochRef.current = currentEpoch;
        // Invalidate all pending async generations on auth-reset
        versionsGeneration.current += 1;
        snapshotGeneration.current += 1;
        restoreGeneration.current += 1;

        // Reset in-memory restore modal state on auth-reset
        setIsRestoring(false);
        setConfirmingRestore(false);
        setPendingRestore(null);
        setRestoreError(null);
      }

      if (!currentOperator) {
        setPendingRestore(null);
        return;
      }

      if (readOnly) return;

      const existing = loadSeasonalRestoreAttempt(undefined, { seasonId, ownerUserId: currentOperator });
      if (existing && (existing.status === 'executing' || existing.status === 'unresolved' || existing.status === 'committed')) {
        const normalized: SeasonalRestoreAttemptPayload = {
          ...existing,
          status: existing.status === 'committed' ? 'committed' : 'unresolved',
        };
        setPendingRestore(normalized);
        setRestoreError(
          existing.error ??
            (existing.status === 'committed'
              ? `Phiên bản ${existing.versionTag} đã được khôi phục trên máy chủ nhưng chưa tải xong vào bản nháp. Vui lòng bấm "Thử lại Đồng bộ" để hoàn tất.`
              : `Có một yêu cầu khôi phục phiên bản ${existing.versionTag} chưa nhận được xác nhận từ máy chủ. Vui lòng bấm "Thử lại Khôi phục" để hoàn tất.`),
        );
        if (onBeginRestore) {
          void onBeginRestore();
        }
      } else {
        setPendingRestore(null);
      }
    };

    syncRestoreFromJournal();
    const unsubscribe = subscribeToSeasonalRestoreState(syncRestoreFromJournal);
    return () => unsubscribe();
  }, [isOpen, onBeginRestore, seasonId, readOnly]);

  // Load versions list
  const loadVersions = useCallback(async (reset = false) => {
    const generation = ++versionsGeneration.current;
    if (reset) {
      nextSequenceRef.current = null;
    }
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const res = await getSeasonalPublishVersionsV1({
        seasonId,
        afterSequence: nextSequenceRef.current ?? undefined,
        pageSize: 50,
      });
      if (generation !== versionsGeneration.current) return;
      nextSequenceRef.current = res.nextSequence ?? null;
      setVersionsHasMore(res.hasMore);
      setVersions((prev) => {
        const next = reset ? res.versions : [...prev, ...res.versions];
        return next;
      });
    } catch (err: unknown) {
      if (generation !== versionsGeneration.current) return;
      setVersionsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === versionsGeneration.current) {
        setVersionsLoading(false);
      }
    }
  }, [seasonId]);

  // Initial load when modal opens
  useEffect(() => {
    let cancelled = false;
    if (isOpen && seasonId) {
      queueMicrotask(() => {
        if (!cancelled) void loadVersions(true);
      });
    } else {
      queueMicrotask(() => {
        if (!cancelled) {
          setVersions([]);
          setSelectedVersion(null);
          nextSequenceRef.current = null;
          snapshotNextDraftIdRef.current = null;
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, seasonId, loadVersions]);

  // Automatically select first version or locked pending version
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (pendingRestore && pendingRestore.versionId) {
        const matching = versions.find((v) => v.version_id === pendingRestore.versionId);
        setSelectedVersion(matching ?? null);
        return;
      }
      if (versions.length > 0 && !selectedVersion) {
        setSelectedVersion(versions[0]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [versions, selectedVersion, pendingRestore]);

  // Load snapshot flights
  const loadSnapshot = useCallback(async (versionId: string, reset = false) => {
    const generation = ++snapshotGeneration.current;
    if (reset) {
      snapshotNextDraftIdRef.current = null;
    }
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const res = await getSeasonalPublishedSnapshotPageV1({
        versionId,
        afterDraftId: snapshotNextDraftIdRef.current ?? undefined,
        pageSize: 100,
      });
      if (generation !== snapshotGeneration.current) return;
      snapshotNextDraftIdRef.current = res.nextDraftId ?? null;
      setSnapshotHasMore(res.hasMore);
      setSnapshotTotalCount(res.totalCount);
      setSnapshotFlights((prev) => (reset ? res.flights : [...prev, ...res.flights]));
    } catch (err: unknown) {
      if (generation !== snapshotGeneration.current) return;
      setSnapshotError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === snapshotGeneration.current) {
        setSnapshotLoading(false);
      }
    }
  }, []);

  // When selectedVersion changes, reset sub-views and fetch snapshot data
  useEffect(() => {
    if (!selectedVersion) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      snapshotNextDraftIdRef.current = null;
      setSnapshotFlights([]);
      void loadSnapshot(selectedVersion.version_id, true);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedVersion, loadSnapshot]);
  // Filter snapshot records locally by date and search query
  const filteredSnapshotFlights = useMemo(() => {
    let result = snapshotFlights;
    if (filterDate) {
      result = result.filter((f) => f.operational_date === filterDate);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((f) => {
        const fn = formatFlightNumber(f.airline, f.flight_number).toLowerCase();
        const route = String(f.route || '').toLowerCase();
        const ac = String(f.aircraft || '').toLowerCase();
        const gate = String(f.gate ?? '').toLowerCase();
        const stand = String(f.stand ?? '').toLowerCase();
        return fn.includes(q) || route.includes(q) || ac.includes(q) || gate.includes(q) || stand.includes(q);
      });
    }
    return result;
  }, [snapshotFlights, filterDate, searchQuery]);

  // Export chosen version as canonical Excel (25 columns) - Purely read-only, no write lock needed
  const handleExportVersion = async () => {
    if (!selectedVersion || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const snapshot = await getSeasonalPublishedExportSnapshotV1({ versionId: selectedVersion.version_id });
      const flightRecords = seasonalDraftExportSnapshotToFlightRecords(snapshot);
      const canonicalExport = buildCanonicalSeasonalRows({
        records: flightRecords,
        modifications: new Map(),
      });
      const validation = validateFlightLegsForSeasonalExport(canonicalExport.effectiveLegs);
      if (!validation.valid) {
        const firstIssue = formatUiError(validation.issues[0]?.message, 'Lỗi kiểm tra tính hợp lệ của chuyến bay.');
        throw new Error(`Dữ liệu phiên bản không hợp lệ để xuất Excel: ${firstIssue}`);
      }
      if (canonicalExport.rows.length === 0) {
        throw new Error('Phiên bản không có chuyến bay nào để xuất.');
      }
      const result = await saveExportBlob({
        blob: exportCanonicalSeasonalRowsToExcel(canonicalExport.rows, seasonCode),
        fileName: `${seasonCode}_${selectedVersion.version_tag}_Updated_${Date.now()}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      notifyExportCompleted(result);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  // Restore chosen version to draft only with durable retry journal & guard
  const handleConfirmRestore = async () => {
    if (isRestoring || readOnly) return;
    const currentOperatorId = getSynchronousOperatorUserId();
    if (!currentOperatorId) {
      setRestoreError('Yêu cầu phiên đăng nhập điều hành viên hợp lệ để thực hiện khôi phục an toàn.');
      return;
    }

    let attempt = pendingRestore;

    // Strict owner fence: current authenticated operator MUST match attempt.ownerUserId!
    if (attempt && attempt.ownerUserId !== currentOperatorId) {
      setRestoreError('Yêu cầu khôi phục này thuộc về phiên làm việc của điều hành viên khác. Không thể thực thi.');
      setPendingRestore(null);
      return;
    }

    // Pre-flight check: validate operator and storage BEFORE acquiring parent lock!
    if (!attempt || attempt.status !== 'committed') {
      if (!attempt) {
        if (!selectedVersion) return;
        attempt = {
          contractVersion: 1,
          ownerUserId: currentOperatorId,
          seasonId,
          seasonCode,
          versionId: selectedVersion.version_id,
          versionTag: selectedVersion.version_tag,
          requestId: crypto.randomUUID(),
          expectedRevision: String(currentDraftRevision ?? '0'),
          expectedEpoch: currentDraftEpoch || '00000000-0000-0000-0000-000000000000',
          startedAt: Date.now(),
          status: 'executing',
        };
        try {
          persistSeasonalRestoreAttempt(undefined, attempt);
        } catch (storageErr) {
          setRestoreError(storageErr instanceof Error ? storageErr.message : String(storageErr));
          return;
        }
      }
    }
    // Case A: RPC already committed on server previously; this is a draft reload retry only!
    if (attempt && attempt.status === 'committed') {
      if (attempt.ownerUserId !== currentOperatorId) {
        setRestoreError('Yêu cầu khôi phục này thuộc về phiên làm việc của điều hành viên khác. Không thể thực thi.');
        setPendingRestore(null);
        return;
      }
      if (onBeginRestore) {
        const allowed = await onBeginRestore();
        if (!allowed) {
          setRestoreError('Không thể thực hiện khôi phục vì có thao tác khác đang chạy hoặc bản nháp đang lưu.');
          return;
        }
      }
      const generation = ++restoreGeneration.current;
      setIsRestoring(true);
      setRestoreError(null);
      try {
        if (onDraftRestored) {
          await onDraftRestored();
        }
        if (generation !== restoreGeneration.current) return;
        // Authoritative reload succeeded! Now we can clear journal and release guard:
        clearSeasonalRestoreAttempt(undefined, seasonId, attempt.requestId, { ownerUserId: attempt.ownerUserId });
        setSeasonalRestoreExecuting(false);
        setPendingRestore(null);
        setRestoreError(null);
        setConfirmingRestore(false);
        if (onFinishRestore) onFinishRestore();
        onClose();
        return;
      } catch (reloadErr) {
        if (generation !== restoreGeneration.current) return;
        // Retain file action guard on failed reload!
        setRestoreError(
          `Đã khôi phục thành công trên máy chủ nhưng tải lại bản nháp thất bại: ${
            reloadErr instanceof Error ? reloadErr.message : String(reloadErr)
          }. Vui lòng nhấn Thử lại để hoàn tất đồng bộ.`,
        );
        return;
      } finally {
        if (generation === restoreGeneration.current) {
          setIsRestoring(false);
        }
      }
    }

    // Case B: Issue restore RPC to server
    if (attempt.ownerUserId !== currentOperatorId) {
      setRestoreError('Yêu cầu khôi phục này thuộc về phiên làm việc của điều hành viên khác. Không thể thực thi.');
      setPendingRestore(null);
      return;
    }
    if (onBeginRestore) {
      const allowed = await onBeginRestore();
      if (!allowed) {
        setRestoreError('Không thể thực hiện khôi phục vì có thao tác khác đang chạy hoặc bản nháp đang lưu.');
        return;
      }
    }

    const generation = ++restoreGeneration.current;
    setIsRestoring(true);
    setRestoreError(null);

    if (attempt.status === 'unresolved') {
      try {
        const updated = markSeasonalRestoreAttemptStatus(undefined, seasonId, attempt.requestId, 'executing', null, {
          ownerUserId: currentOperatorId,
        });
        if (!updated) {
          if (onFinishRestore) onFinishRestore();
          setIsRestoring(false);
          setRestoreError('Không thể cập nhật nhật ký khôi phục trong lưu trữ (phiên điều hành không khớp hoặc đã bị xoá).');
          return;
        }
      } catch (storageErr) {
        if (onFinishRestore) onFinishRestore();
        setIsRestoring(false);
        setRestoreError(storageErr instanceof Error ? storageErr.message : String(storageErr));
        return;
      }
      attempt = { ...attempt, status: 'executing' };
    }

    setPendingRestore(attempt);
    setSeasonalRestoreExecuting(true, attempt);

    try {
      const result = await restoreSeasonalPublishedDraftV1({
        seasonId: attempt.seasonId,
        versionId: attempt.versionId,
        requestId: attempt.requestId,
        expectedRevision: attempt.expectedRevision,
        expectedEpoch: attempt.expectedEpoch,
      });

      if (generation !== restoreGeneration.current) return;

      if (result.status === 'committed') {
        // Persist receipt status 'committed' FIRST
        try {
          markSeasonalRestoreAttemptStatus(undefined, seasonId, attempt.requestId, 'committed', null, {
            ownerUserId: attempt.ownerUserId,
          });
        } catch (storageErr) {
          console.error('Failed to mark restore attempt committed in journal:', storageErr);
        }
        attempt = { ...attempt, status: 'committed' };
        setPendingRestore(attempt);

        // Now reload authoritative draft:
        try {
          if (onDraftRestored) {
            await onDraftRestored(result);
          }
          if (generation !== restoreGeneration.current) return;
          // Authoritative reload succeeded! Now we can clear journal and release guard:
          clearSeasonalRestoreAttempt(undefined, seasonId, attempt.requestId, { ownerUserId: attempt.ownerUserId });
          setSeasonalRestoreExecuting(false);
          setPendingRestore(null);
          setRestoreError(null);
          setConfirmingRestore(false);
          if (onFinishRestore) onFinishRestore();
          onClose();
          return;
        } catch (reloadErr) {
          // Reload failed: KEEP attempt as 'committed' in journal!
          // Retain file action guard on failed reload!
          setRestoreError(
            `Đã khôi phục thành công trên máy chủ nhưng tải lại bản nháp thất bại: ${
              reloadErr instanceof Error ? reloadErr.message : String(reloadErr)
            }. Vui lòng nhấn Thử lại để tải lại bản nháp.`,
          );
          return;
        }
      }
    } catch (err: unknown) {
      if (generation !== restoreGeneration.current) return;

      const message = err instanceof Error ? err.message : String(err);
      const isDeterministicConflict = isDeterministicDraftConflictError(err);

      if (isDeterministicConflict) {
        // Stale conflict: reload authoritative draft
        try {
          if (onDraftRestored) {
            await onDraftRestored();
          }
          if (generation !== restoreGeneration.current) return;
          // Authoritative reload succeeded! Now we can clear journal and release guard:
          clearSeasonalRestoreAttempt(undefined, seasonId, attempt.requestId, { ownerUserId: attempt.ownerUserId });
          setSeasonalRestoreExecuting(false);
          setPendingRestore(null);
          if (onFinishRestore) onFinishRestore();
          setRestoreError(
            `Yêu cầu khôi phục bị từ chối do bản nháp đã thay đổi trên máy chủ (${message}). Đã đồng bộ lại bản nháp mới nhất từ máy chủ.`,
          );
        } catch (reloadErr) {
          // Authoritative reload FAILED: RETAIN guard and journal!
          try {
            markSeasonalRestoreAttemptStatus(
              undefined,
              seasonId,
              attempt.requestId,
              'unresolved',
              `Xung đột bản nháp nhưng nạp lại thất bại: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`,
              { ownerUserId: attempt.ownerUserId },
            );
          } catch {
            // ignore storage error
          }
          setSeasonalRestoreExecuting(false);
          setPendingRestore({ ...attempt, status: 'unresolved' });
          setRestoreError(
            `Yêu cầu bị từ chối do xung đột bản nháp, và việc đồng bộ lại bản nháp thất bại: ${
              reloadErr instanceof Error ? reloadErr.message : String(reloadErr)
            }. Vui lòng thử lại.`,
          );
        }
      } else {
        // Network / unknown transport failure: retain attempt as unresolved for retry
        try {
          markSeasonalRestoreAttemptStatus(undefined, seasonId, attempt.requestId, 'unresolved', message, {
            ownerUserId: attempt.ownerUserId,
          });
        } catch (storageErr) {
          console.error('Failed to mark restore attempt unresolved in journal:', storageErr);
        }
        setSeasonalRestoreExecuting(false);
        setPendingRestore({ ...attempt, status: 'unresolved', error: message });
        setRestoreError(
          `Chưa nhận được kết quả xác nhận từ máy chủ (${message}). Yêu cầu đã được lưu an toàn. Vui lòng bấm "Thử lại Khôi phục" để nhận kết quả xác nhận.`,
        );
      }
    } finally {
      if (generation === restoreGeneration.current) {
        setIsRestoring(false);
      }
    }
  };

  const handleCancelRestoreModal = () => {
    if (isRestoreBlocked) return;
    setConfirmingRestore(false);
    setRestoreError(null);
  };

  const handleSafeClose = () => {
    if (isRestoreBlocked) return;
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-scrim/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="seasonal-history-title"
    >
      <div className="relative flex h-[90vh] w-[95vw] max-w-7xl flex-col rounded-2xl bg-surface border border-outline-variant shadow-2xl overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-outline-variant px-6 py-4 bg-surface">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="seasonal-history-title" className="text-lg font-bold text-on-surface">
                Lịch sử phiên bản lịch mùa
              </h2>
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
                {seasonCode}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-on-surface-variant">
              Tra cứu bản lưu lịch mùa, so sánh các phiên bản, xuất Excel và khôi phục về bản nháp lịch mùa.
            </p>
          </div>
          <button
            onClick={handleSafeClose}
            disabled={isRestoreBlocked}
            className="rounded-lg p-1.5 text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Đóng"
            title={isRestoreBlocked ? 'Không thể đóng khi đang có yêu cầu khôi phục chưa hoàn tất đồng bộ' : 'Đóng'}
          >
            ✕
          </button>
        </header>

        {/* Pending Restore Alert Banner: distinguishes committed vs unresolved */}
        {pendingRestore && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
              <span className="material-symbols-outlined text-[18px] text-amber-600">
                {isRestoreCommitted ? 'sync_problem' : 'warning'}
              </span>
              <span>
                {isRestoreCommitted ? (
                  <>
                    Phiên bản <strong>{pendingRestore.versionTag}</strong> đã ghi nhận thành công trên máy chủ, đang chờ tải lại vào bản nháp (Mã yêu cầu: {pendingRestore.requestId.slice(0, 8)}...). Vui lòng nhấn &quot;Đồng bộ lại&quot; để tải bản nháp. Chức năng chuyển phiên bản và đóng màn hình đang tạm khóa.
                  </>
                ) : (
                  <>
                    Yêu cầu khôi phục phiên bản <strong>{pendingRestore.versionTag}</strong> chưa nhận được xác nhận từ máy chủ (Mã yêu cầu: {pendingRestore.requestId.slice(0, 8)}...). Vui lòng nhấn Thử lại để hoàn tất. Chức năng chuyển phiên bản và đóng màn hình đang tạm khóa để bảo vệ dữ liệu.
                  </>
                )}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (isRestoreCommitted) {
                  void handleConfirmRestore();
                } else {
                  setConfirmingRestore(true);
                }
              }}
              disabled={isRestoring}
              className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {isRestoreCommitted ? 'Đồng bộ lại' : 'Thử lại ngay'}
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel: Versions list */}
          <aside className="w-80 border-r border-outline-variant flex flex-col bg-surface-variant/10">
            <div className="border-b border-outline-variant p-3 bg-surface flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                Danh sách Phiên bản ({versions.length})
              </span>
              <button
                type="button"
                onClick={() => void loadVersions(true)}
                disabled={versionsLoading || isRestoreBlocked}
                className="text-[11px] font-semibold text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Làm mới
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-outline-variant/30">
              {versionsLoading && versions.length === 0 && (
                <div className="p-8 text-center text-xs text-on-surface-variant">
                  <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Đang tải danh sách phiên bản...
                </div>
              )}

              {versionsError && (
                <div className="p-4 text-xs text-error">
                  <p className="font-semibold">Lỗi tải phiên bản:</p>
                  <p className="mt-1">{formatUiError(versionsError)}</p>
                </div>
              )}

              {!versionsLoading && versions.length === 0 && !versionsError && (
                <div className="p-8 text-center text-xs text-on-surface-variant">
                  Chưa có phiên bản nào được công bố cho mùa này.
                </div>
              )}

              {versions.map((ver) => {
                const isSelected = selectedVersion?.version_id === ver.version_id;
                const kind = ver.publish_kind || 'release';
                return (
                  <button
                    key={ver.version_id}
                    type="button"
                    onClick={() => {
                      if (isRestoreBlocked) return;
                      setSelectedVersion(ver);
                    }}
                    disabled={isRestoreBlocked}
                    className={`w-full p-3 text-left transition-colors flex flex-col gap-1.5 disabled:cursor-not-allowed ${
                      isSelected
                        ? 'bg-primary/10 border-l-4 border-primary'
                        : 'hover:bg-surface-variant/30 border-l-4 border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-bold text-sm text-primary">{ver.version_tag}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                          kind === 'noop'
                            ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
                            : kind === 'reapply'
                            ? 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-300'
                            : 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                        }`}
                      >
                        {formatUiValue(kind, 'publishKind')}
                      </span>
                    </div>

                    <div className="text-[11px] text-on-surface-variant flex items-center justify-between">
                      <span>{new Date(ver.published_at).toLocaleString('vi-VN')}</span>
                      <span>{ver.published_by ? `Bởi: ${ver.published_by.slice(0, 8)}` : ''}</span>
                    </div>

                    {/* Planning counts summary */}
                    <div className="flex items-center gap-2 text-[10px] font-mono text-on-surface-variant">
                      <span className="text-emerald-600 font-bold">+{ver.added_count}</span>
                      <span className="text-amber-600 font-bold">~{ver.modified_count}</span>
                      <span className="text-rose-600 font-bold">-{ver.removed_count}</span>
                      <span className="text-slate-500">={ver.unchanged_count}</span>
                      {ver.skipped_days && ver.skipped_days.length > 0 && (
                        <span className="ml-auto rounded bg-slate-200 dark:bg-slate-700 px-1 text-[9px] text-on-surface">
                          {ver.skipped_days.length} ngày lịch ngày
                        </span>
                      )}
                    </div>

                    {ver.publish_notes && (
                      <p className="text-[11px] italic text-on-surface-variant line-clamp-1">
                        &quot;{ver.publish_notes}&quot;
                      </p>
                    )}
                  </button>
                );
              })}

              {versionsHasMore && (
                <div className="p-3 text-center">
                  <button
                    type="button"
                    onClick={() => void loadVersions(false)}
                    disabled={versionsLoading || isRestoreBlocked}
                    className="w-full rounded border border-outline-variant py-1.5 text-xs font-semibold text-primary hover:bg-surface-variant/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {versionsLoading ? 'Đang tải thêm...' : 'Tải thêm phiên bản'}
                  </button>
                </div>
              )}
            </div>
          </aside>

          {/* Right panel: Version Details */}
          <main className="flex-1 flex flex-col min-w-0 bg-surface">
            {selectedVersion ? (
              <>
                {/* Selected Version Action Header */}
                <div className="border-b border-outline-variant p-4 bg-surface flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-base font-bold text-on-surface">{selectedVersion.version_tag}</h3>
                      <span className="text-xs text-on-surface-variant">
                        Tổng số: <strong>{selectedVersion.total_flight_count || snapshotTotalCount}</strong> chuyến bay
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-4 text-xs text-on-surface-variant">
                      <span>Thời gian: {new Date(selectedVersion.published_at).toLocaleString('vi-VN')}</span>
                      {selectedVersion.snapshot_checksum && (
                        <span>
                          Mã kiểm tra: <code className="font-mono">{selectedVersion.snapshot_checksum.slice(0, 8)}</code>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Export chosen version button */}
                    <button
                      type="button"
                      onClick={() => void handleExportVersion()}
                      disabled={isExporting}
                      className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-variant/50 disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[16px]">download</span>
                      <span>{isExporting ? 'Đang xuất...' : 'Xuất Excel 25 cột'}</span>
                    </button>

                    {/* Restore to Draft button */}
                    <button
                      type="button"
                      onClick={() => setConfirmingRestore(true)}
                      disabled={isRestoring || isRestricted || readOnly}
                      title={
                        isRestricted || readOnly
                          ? restrictedReason || 'Không thể khôi phục trong trạng thái hiện tại'
                          : 'Khôi phục toàn bộ chuyến bay của phiên bản này vào bản nháp Kế hoạch'
                      }
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[16px]">restore</span>
                      <span>{pendingRestore && pendingRestore.status === 'unresolved' ? 'Thử lại Khôi phục' : 'Khôi phục về Bản nháp'}</span>
                    </button>
                  </div>
                </div>

                {exportError && (
                  <div className="bg-error/10 border-b border-error/20 px-4 py-2 text-xs text-error flex items-center justify-between">
                    <span>Lỗi xuất file: {formatUiError(exportError)}</span>
                    <button type="button" onClick={() => setExportError(null)} className="text-[10px] underline">
                      Bỏ qua
                    </button>
                  </div>
                )}

                {restoreError && !isRestoreUnresolved && (
                  <div className="bg-error/10 border-b border-error/20 px-4 py-2 text-xs text-error flex items-center justify-between">
                    <span>Lỗi khôi phục: {formatUiError(restoreError)}</span>
                    <button type="button" onClick={() => setRestoreError(null)} className="text-[10px] underline">
                      Đóng
                    </button>
                  </div>
                )}

                {/* Sub-view Tabs */}
                <div className="border-b border-outline-variant px-4 bg-surface flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('snapshot')}
                    className={`py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                      activeTab === 'snapshot'
                        ? 'border-primary text-primary'
                        : 'border-transparent text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    Bản lưu chuyến bay
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('diff')}
                    className={`py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                      activeTab === 'diff'
                        ? 'border-primary text-primary'
                        : 'border-transparent text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    So sánh phiên bản
                  </button>
                </div>

                {/* Tab 1: Snapshot View */}
                {activeTab === 'snapshot' && (
                  <div className="flex-1 flex flex-col min-h-0">
                    {snapshotError && (
                      <div className="bg-error/10 border-b border-error/20 p-3 text-xs text-error flex items-center justify-between">
                        <span>Lỗi tải bản lưu danh sách chuyến bay: {formatUiError(snapshotError)}</span>
                        <button
                          type="button"
                          onClick={() => void loadSnapshot(selectedVersion.version_id, true)}
                          className="font-semibold underline hover:text-error/80"
                        >
                          Thử lại
                        </button>
                      </div>
                    )}
                    {/* Filters bar */}
                    <div className="p-3 border-b border-outline-variant bg-surface flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[200px]">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Tìm chuyến bay, tuyến bay, tàu bay, cửa, vị trí đỗ..."
                          className="w-full rounded-lg border border-outline-variant px-3 py-1.5 text-xs bg-surface text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      <div className="w-40">
                        <input
                          type="date"
                          value={filterDate}
                          onChange={(e) => setFilterDate(e.target.value)}
                          className="w-full rounded-lg border border-outline-variant px-3 py-1.5 text-xs bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      {filterDate && (
                        <button
                          type="button"
                          onClick={() => setFilterDate('')}
                          className="text-xs text-primary hover:underline"
                        >
                          Xóa lọc ngày
                        </button>
                      )}
                      <span className="text-[11px] text-on-surface-variant ml-auto">
                        Hiển thị <strong>{filteredSnapshotFlights.length}</strong> / {snapshotFlights.length} chuyến đã tải
                      </span>
                    </div>

                    {/* Snapshot table */}
                    <div className="flex-1 overflow-auto">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead className="sticky top-0 bg-surface-variant/40 backdrop-blur border-b border-outline-variant text-[11px] font-bold text-on-surface-variant uppercase">
                          <tr>
                            <th className="py-2 px-3">Ngày kế hoạch</th>
                            <th className="py-2 px-3">Hãng</th>
                            <th className="py-2 px-3">Số hiệu</th>
                            <th className="py-2 px-3">Chặng</th>
                            <th className="py-2 px-3">Tuyến</th>
                            <th className="py-2 px-3">Giờ kế hoạch</th>
                            <th className="py-2 px-3">Tàu bay</th>
                            <th className="py-2 px-3">Cửa / Vị trí đỗ</th>
                            <th className="py-2 px-3">Khách</th>
                            <th className="py-2 px-3">Băng chuyền</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-variant/30">
                          {filteredSnapshotFlights.map((f) => (
                            <tr key={f.draft_id} className="hover:bg-surface-variant/15 transition-colors">
                              <td className="py-1.5 px-3 font-mono text-on-surface">{f.operational_date}</td>
                              <td className="py-1.5 px-3 font-bold text-on-surface">{f.airline}</td>
                              <td className="py-1.5 px-3 font-bold text-primary">{f.flight_number}</td>
                              <td className="py-1.5 px-3">{f.type === 'A' ? 'Đến' : 'Đi'}</td>
                              <td className="py-1.5 px-3 font-mono text-on-surface-variant">{f.route}</td>
                              <td className="py-1.5 px-3 font-mono font-medium text-on-surface">{f.schedule || '-'}</td>
                              <td className="py-1.5 px-3 text-on-surface-variant">{f.aircraft || '-'}</td>
                              <td className="py-1.5 px-3 text-on-surface-variant">{f.gate || f.stand || '-'}</td>
                              <td className="py-1.5 px-3 font-mono text-on-surface">{f.pax ?? '-'}</td>
                              <td className="py-1.5 px-3 text-on-surface-variant">{f.carousel || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {snapshotLoading && (
                        <div className="p-8 text-center text-xs text-on-surface-variant">
                          <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          Đang tải dữ liệu chuyến bay...
                        </div>
                      )}

                      {!snapshotLoading && filteredSnapshotFlights.length === 0 && (
                        <div className="p-8 text-center text-xs text-on-surface-variant">
                          Không có chuyến bay nào phù hợp điều kiện lọc.
                        </div>
                      )}

                      {snapshotHasMore && (
                        <div className="p-3 text-center border-t border-outline-variant bg-surface">
                          <button
                            type="button"
                            onClick={() => void loadSnapshot(selectedVersion.version_id, false)}
                            disabled={snapshotLoading}
                            className="rounded-lg border border-outline-variant px-4 py-1.5 text-xs font-semibold text-primary hover:bg-surface-variant/50 disabled:opacity-50"
                          >
                            {snapshotLoading ? 'Đang tải...' : 'Tải thêm chuyến bay (100 chuyến tiếp theo)'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Tab 2: Diff View */}
                {activeTab === 'diff' && (
                  <SeasonalVersionChangesView
                    versionId={selectedVersion.version_id}
                    disabled={isRestoreBlocked}
                    versions={versions}
                  />
                )}
              </>
            ) : pendingRestore ? (
              <div className="flex-1 flex flex-col p-6 items-center justify-center max-w-lg mx-auto text-center">
                <div className="rounded-full bg-amber-500/10 p-3 text-amber-600 mb-3">
                  <span className="material-symbols-outlined text-[32px]">
                    {isRestoreCommitted ? 'sync_problem' : 'pending_actions'}
                  </span>
                </div>
                <h3 className="text-base font-bold text-on-surface">
                  {isRestoreCommitted
                    ? 'Đã ghi nhận trên máy chủ - Đang chờ tải lại bản nháp'
                    : 'Yêu cầu Khôi phục chưa hoàn tất'}
                </h3>
                <p className="mt-1 text-xs text-on-surface-variant">
                  {isRestoreCommitted ? (
                    <>
                      Phiên bản <strong>{pendingRestore.versionTag}</strong> đã được ghi nhận thành công trên máy chủ nhưng chưa tải xong vào bản nháp. Vui lòng bấm &quot;Đồng bộ lại&quot; để tải bản nháp.
                    </>
                  ) : (
                    <>
                      Có một yêu cầu khôi phục phiên bản <strong>{pendingRestore.versionTag}</strong> đang chờ hoàn tất xác nhận từ máy chủ.
                    </>
                  )}
                </p>

                <div className="mt-4 w-full rounded-xl border border-outline-variant bg-surface-variant/20 p-4 text-left text-xs space-y-1.5 font-mono">
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Phiên bản:</span>
                    <span className="font-bold text-primary font-sans">{pendingRestore.versionTag}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Trạng thái:</span>
                    <span className="font-semibold text-amber-600 font-sans">
                      {isRestoreCommitted ? 'Đã ghi nhận (chờ tải lại)' : 'Chờ xác nhận'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Mã yêu cầu:</span>
                    <span className="truncate max-w-[240px]">{pendingRestore.requestId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Số hiệu sửa đổi dự kiến:</span>
                    <span>{pendingRestore.expectedRevision}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Thời điểm:</span>
                    <span className="font-sans">{new Date(pendingRestore.startedAt).toLocaleString('vi-VN')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant font-sans">Điều hành viên:</span>
                    <span className="truncate max-w-[200px]">{pendingRestore.ownerUserId}</span>
                  </div>
                </div>

                {restoreError && (
                  <div className="mt-4 w-full rounded-lg bg-error/10 border border-error/20 p-2.5 text-xs text-error text-left">
                    {formatUiError(restoreError)}
                  </div>
                )}

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (isRestoreCommitted) {
                        void handleConfirmRestore();
                      } else {
                        setConfirmingRestore(true);
                      }
                    }}
                    disabled={isRestoring}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm hover:bg-primary/90 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {isRestoreCommitted ? 'sync' : 'restore'}
                    </span>
                    <span>{isRestoreCommitted ? 'Đồng bộ lại Bản nháp' : 'Thử lại Khôi phục'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-on-surface-variant">
                Vui lòng chọn một phiên bản ở danh sách bên trái để xem chi tiết.
              </div>
            )}
          </main>
        </div>

        {/* Footer */}
        <footer className="border-t border-outline-variant px-6 py-3 bg-surface flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">
            Lưu ý: Mọi phiên bản được công bố đều được lưu trữ vĩnh viễn và không thể chỉnh sửa trực tiếp.
          </span>
          <button
            type="button"
            onClick={handleSafeClose}
            disabled={isRestoreBlocked}
            className="rounded-lg border border-outline-variant px-4 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-variant/50 disabled:opacity-40 disabled:cursor-not-allowed"
            title={isRestoreBlocked ? 'Không thể đóng khi đang có yêu cầu khôi phục chưa hoàn tất đồng bộ' : undefined}
          >
            Đóng
          </button>
        </footer>

        {/* Confirmation Modal for Restore */}
        {confirmingRestore && (selectedVersion || pendingRestore) && (
          <div className="fixed inset-0 z-[1050] flex items-center justify-center bg-scrim/60 p-4">
            <div className="w-full max-w-[448px] max-h-[90vh] overflow-y-auto rounded-xl bg-surface border border-outline-variant p-6 shadow-2xl flex flex-col gap-4">
              <div className="flex items-center gap-3 text-amber-600">
                <span className="material-symbols-outlined text-[28px]">warning</span>
                <h4 className="text-base font-bold text-on-surface">
                  {pendingRestore && pendingRestore.status === 'unresolved'
                    ? 'Thử lại Khôi phục Bản nháp'
                    : 'Xác nhận Khôi phục về Bản nháp'}
                </h4>
              </div>

              <div className="text-xs text-on-surface-variant space-y-2">
                <p>
                  Bạn đang yêu cầu khôi phục toàn bộ chuyến bay của phiên bản{' '}
                  <strong className="text-primary">{selectedVersion?.version_tag || pendingRestore?.versionTag}</strong> vào{' '}
                  <strong>Bản nháp lịch mùa</strong>.
                </p>
                <div className="rounded-lg bg-surface-variant/30 p-3 border border-outline-variant space-y-1">
                  <div>
                    Mã phiên bản: <strong>{selectedVersion?.version_tag || pendingRestore?.versionTag}</strong>
                  </div>
                  <div>
                    Ngày công bố:{' '}
                    <strong>
                      {selectedVersion
                        ? new Date(selectedVersion.published_at).toLocaleString('vi-VN')
                        : pendingRestore
                        ? new Date(pendingRestore.startedAt).toLocaleString('vi-VN')
                        : '-'}
                    </strong>
                  </div>
                  <div>
                    Số hiệu sửa đổi bản nháp dự kiến:{' '}
                    <strong>
                      {pendingRestore ? pendingRestore.expectedRevision : currentDraftRevision ?? 0}
                    </strong>
                  </div>
                  {pendingRestore && (
                    <div className="text-amber-800 dark:text-amber-200 font-mono text-[10px] pt-1">
                      Mã yêu cầu: {pendingRestore.requestId}
                    </div>
                  )}
                </div>
                <p className="text-rose-600 dark:text-rose-400 font-semibold">
                  ⚠️ Lưu ý quan trọng:
                </p>
                <ul className="list-disc pl-5 space-y-1 text-on-surface-variant">
                  <li>Toàn bộ thay đổi chưa lưu trong bản nháp hiện tại sẽ bị thay thế.</li>
                  <li>
                    Phân hệ <strong>Vận hành</strong> và <strong>Lịch ngày</strong>{' '}
                    hoàn toàn KHÔNG bị thay đổi.
                  </li>
                  <li>
                    Sau khi khôi phục, bạn cần kiểm tra lại bản nháp và thực hiện quy trình{' '}
                    <strong>Công bố</strong> bình thường nếu muốn áp dụng sang Vận hành.
                  </li>
                </ul>
              </div>

              {restoreError && (
                <div className="rounded-lg bg-error/10 border border-error/20 p-2.5 text-xs text-error">
                  {formatUiError(restoreError)}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCancelRestoreModal}
                  disabled={isRestoreBlocked}
                  className="rounded-lg border border-outline-variant px-4 py-2 text-xs font-semibold text-on-surface hover:bg-surface-variant/50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={isRestoreBlocked ? 'Không thể hủy khi đang có yêu cầu khôi phục chưa hoàn tất đồng bộ' : undefined}
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRestore()}
                  disabled={isRestoring}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-on-primary hover:bg-primary/90 disabled:opacity-40 shadow-sm"
                >
                  {isRestoring && (
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  )}
                  {isRestoring
                    ? 'Đang khôi phục...'
                    : pendingRestore && pendingRestore.status === 'unresolved'
                    ? 'Thử lại Khôi phục'
                    : 'Đồng ý Khôi phục'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
