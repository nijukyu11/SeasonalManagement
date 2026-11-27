'use client';

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
  previewSeasonalPublishV1,
  getSeasonalPublishPreviewPageV1,
  getSeasonalPublishOperationalImpactPageV1,
  commitSeasonalPublishV1,
} from '@/lib/remoteStore';
import { useOperationalScheduleStore } from '@/lib/operationalScheduleAdapter';
import { setSeasonalPublishActive } from '@/lib/seasonalMutationFences';
import {
  formatFlightState,
  formatDiffSummary,
  formatDayRanges,
  formatFlightNumber,
} from '@/lib/seasonalDiffFormatters';
import { formatUiError, formatUiRecord, formatUiValue } from '@/lib/uiDisplayText';
import type {
  SeasonalPublishPreviewResult,
  SeasonalPublishCommitResult,
  SeasonalPublishedDiffEntry,
  SeasonalPublishOperationalImpactEntry,
} from '@/lib/seasonalPlanningContract';

interface SeasonalPublishModalProps {
  isOpen: boolean;
  seasonId: string;
  seasonCode: string;
  onClose: () => void;
}

export default function SeasonalPublishModal({
  isOpen,
  seasonId,
  seasonCode,
  onClose,
}: SeasonalPublishModalProps) {
  const [stage, setStage] = useState<'loading' | 'preview' | 'committing' | 'committed' | 'error'>('loading');
  const [previewResult, setPreviewResult] = useState<SeasonalPublishPreviewResult | null>(null);
  const [diffTab, setDiffTab] = useState<'planning' | 'operational'>('planning');
  const [diffEntries, setDiffEntries] = useState<SeasonalPublishedDiffEntry[]>([]);
  const [impactEntries, setImpactEntries] = useState<SeasonalPublishOperationalImpactEntry[]>([]);
  const [diffPageSize] = useState(20);
  const [diffHasMore, setDiffHasMore] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [impactHasMore, setImpactHasMore] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [acknowledgedOperational, setAcknowledgedOperational] = useState(false);
  const [acknowledgedHash, setAcknowledgedHash] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const committing = useRef(false);
  const [notes, setNotes] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [commitResult, setCommitResult] = useState<SeasonalPublishCommitResult | null>(null);
  const notesId = useId();
  const loadPreview = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setStage('loading');
    setPreviewResult(null);
    setDiffEntries([]);
    setDiffHasMore(false);
    setDiffError(null);
    setImpactEntries([]);
    setImpactHasMore(false);
    setImpactError(null);
    setAcknowledgedOperational(false);
    setAcknowledgedHash(null);
    setErrorMessage(null);
    setIsStale(false);
    setDiffLoading(true);
    try {
      const result = await previewSeasonalPublishV1({ seasonId, requestId: crypto.randomUUID() });
      if (generation !== requestGeneration.current) return;
      setPreviewResult(result);
      const [page, impactPage] = await Promise.all([
        getSeasonalPublishPreviewPageV1({
          previewId: result.previewId,
          previewHash: result.previewHash,
          afterIndex: 0,
          pageSize: diffPageSize,
        }),
        getSeasonalPublishOperationalImpactPageV1({
          previewId: result.previewId,
          previewHash: result.previewHash,
          afterIndex: 0,
          pageSize: diffPageSize,
        }).catch((err) => {
          if (generation === requestGeneration.current) {
            setImpactError(formatUiError(err, 'Không tải được tác động đến vận hành.'));
          }
          return null;
        }),
      ]);
      if (generation !== requestGeneration.current) return;
      setDiffEntries(page.entries);
      setDiffHasMore(page.hasMore);
      if (impactPage) {
        setImpactEntries(impactPage.entries);
        setImpactHasMore(impactPage.hasMore);
      }
      setIsStale(Boolean(page.stale || impactPage?.stale));
      setStage('preview');
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setStage('error');
      setErrorMessage(formatUiError(err, 'Không thể tạo bản xem trước công bố.'));
    } finally {
      if (generation === requestGeneration.current) setDiffLoading(false);
    }
  }, [seasonId, diffPageSize]);

  useEffect(() => {
    if (isOpen) {
      queueMicrotask(() => {
        void loadPreview();
      });
    } else {
      queueMicrotask(() => {
        setPreviewResult(null);
        setDiffEntries([]);
        setImpactEntries([]);
        setNotes('');
        setCommitResult(null);
        setErrorMessage(null);
        setIsStale(false);
        setAcknowledgedOperational(false);
        setAcknowledgedHash(null);
        setDiffTab('planning');
      });
    }
    return () => { requestGeneration.current += 1; };
  }, [isOpen, loadPreview]);

  useEffect(() => {
    if (stage !== 'committing') return;
    setSeasonalPublishActive(true);
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => {
      setSeasonalPublishActive(false);
      window.removeEventListener('beforeunload', preventUnload);
    };
  }, [stage]);

  const loadNextDiffPage = async () => {
    if (!previewResult || !diffHasMore || diffLoading || committing.current) return;
    const lastEntry = diffEntries[diffEntries.length - 1];
    if (!lastEntry) return;
    const generation = requestGeneration.current;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const page = await getSeasonalPublishPreviewPageV1({
        previewId: previewResult.previewId,
        previewHash: previewResult.previewHash,
        afterIndex: Number(lastEntry.entry_index),
        pageSize: diffPageSize,
      });
      if (generation !== requestGeneration.current) return;
      setDiffEntries((entries) => [...entries, ...page.entries]);
      setDiffHasMore(page.hasMore);
      if (page.stale) setIsStale(true);
    } catch (err: unknown) {
      if (generation === requestGeneration.current) {
        setDiffError(formatUiError(err, 'Không tải được chi tiết thay đổi.'));
      }
    } finally {
      if (generation === requestGeneration.current) setDiffLoading(false);
    }
  };

  const loadNextImpactPage = async () => {
    if (!previewResult || !impactHasMore || impactLoading || committing.current) return;
    const lastEntry = impactEntries[impactEntries.length - 1];
    if (!lastEntry) return;
    const generation = requestGeneration.current;
    setImpactLoading(true);
    setImpactError(null);
    try {
      const page = await getSeasonalPublishOperationalImpactPageV1({
        previewId: previewResult.previewId,
        previewHash: previewResult.previewHash,
        afterIndex: Number(lastEntry.entry_index),
        pageSize: diffPageSize,
      });
      if (generation !== requestGeneration.current) return;
      setImpactEntries((entries) => [...entries, ...page.entries]);
      setImpactHasMore(page.hasMore);
      if (page.stale) setIsStale(true);
    } catch (err: unknown) {
      if (generation === requestGeneration.current) {
        setImpactError(formatUiError(err, 'Không tải được tác động đến vận hành.'));
      }
    } finally {
      if (generation === requestGeneration.current) setImpactLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!previewResult || previewResult.status !== 'ready' || stage !== 'preview' || isStale || diffLoading || impactLoading || Boolean(diffError) || Boolean(impactError) || committing.current) return;
    if (previewResult.preview.publishKind === 'noop') return;
    if (previewResult.preview.requiresOperationalAcknowledgement && (!acknowledgedOperational || acknowledgedHash !== previewResult.previewHash)) return;
    committing.current = true;
    setStage('committing');
    setErrorMessage(null);
    try {
      const result = await commitSeasonalPublishV1({
        seasonId,
        previewId: previewResult.previewId,
        previewHash: previewResult.previewHash,
        notes,
        acknowledgeOperational: Boolean(acknowledgedOperational),
      });
      const publishedDates = previewResult.preview.publishableDays ?? [];
      if (publishedDates.length > 0) {
        useOperationalScheduleStore.getState().invalidateDates(publishedDates);
      }
      setCommitResult(result);
      setStage('committed');
    } catch (err: unknown) {
      setStage('preview');
      const errObj = err as { code?: string; message?: string };
      if (errObj.code === '40001' || errObj.message?.includes('stale')) {
        setIsStale(true);
        setErrorMessage('Dữ liệu lịch mùa hoặc phạm vi lịch ngày đã thay đổi. Vui lòng tải lại bản so sánh.');
      } else {
        setErrorMessage(formatUiError(err, 'Không thể công bố lịch bay.'));
      }
    } finally {
      committing.current = false;
    }
  };

  if (!isOpen) return null;

  const preview = previewResult?.preview;
  const isBlocked = previewResult?.status === 'blocked';

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-scrim/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="seasonal-publish-title"
    >
      <div className="my-auto flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-2xl">
        {/* Header */}
        <header className="flex items-start justify-between border-b border-outline-variant px-6 py-4">
          <div>
            <h2 id="seasonal-publish-title" className="text-lg font-bold text-on-surface">
              Công bố lịch mùa
            </h2>
            <p className="mt-0.5 text-xs text-on-surface-variant">
              Mùa: <span className="font-semibold text-primary">{seasonCode}</span> · Từ kế hoạch mùa sang lịch vận hành
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={stage === 'committing'}
            className="rounded-lg p-1.5 text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface"
            aria-label="Đóng"
          >
            ✕
          </button>
        </header>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {stage === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="mt-3 text-sm text-on-surface-variant font-medium">Đang so sánh thay đổi và đối chiếu các ngày đã có lịch ngày...</p>
            </div>
          )}

          {stage === 'error' && (
            <div className="rounded-lg border border-error/30 bg-error-container/20 p-4 text-on-error-container">
              <div className="font-semibold">Không thể tạo bản xem trước công bố</div>
              <p className="mt-1 text-sm">{errorMessage}</p>
              <button
                type="button"
                onClick={() => void loadPreview()}
                className="mt-3 rounded bg-error px-3 py-1.5 text-xs font-semibold text-on-error"
              >
                Thử lại
              </button>
            </div>
          )}

          {stage === 'committed' && commitResult && (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-2xl text-emerald-600">
                ✓
              </div>
              <h3 className="text-xl font-bold text-on-surface">Công bố Lịch bay thành công!</h3>
              <div className="rounded-lg border border-outline-variant bg-surface-variant/30 p-4 text-sm max-w-md w-full text-left space-y-1">
                <div>Phiên bản: <strong className="text-primary">{commitResult.versionTag}</strong></div>
                {commitResult.publishKind && (
                  <div>Loại công bố: <strong>{formatUiValue(commitResult.publishKind, 'publishKind')}</strong></div>
                )}
                <div>Chuyến đã ghi vào vận hành: <strong>{commitResult.operationalCounts.write}</strong></div>
                <div>Chuyến đã thu hồi: <strong>{commitResult.operationalCounts.retire}</strong></div>
                {commitResult.operationalImpactCounts && (
                  <div>Chuyến ghi đè lên dữ liệu vận hành: <strong>{commitResult.operationalImpactCounts.overwrites}</strong></div>
                )}
                <div>Ngày giữ nguyên lịch ngày: <strong>{commitResult.skippedDays.length} ngày</strong></div>
              </div>
              <button
                onClick={onClose}
                className="mt-4 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-on-primary hover:bg-primary/90"
              >
                Hoàn tất và đóng
              </button>
            </div>
          )}

          {(stage === 'preview' || stage === 'committing') && preview && (
            <>
              {isStale && (
                <div className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                  <span>Dữ liệu đã thay đổi kể từ lần tạo bản so sánh này. Vui lòng tải lại bản so sánh trước khi công bố.</span>
                  <button
                    type="button"
                    onClick={() => void loadPreview()}
                    className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    Tải lại bản so sánh
                  </button>
                </div>
              )}

              {/* Version & Tag preview card */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Phiên bản đề xuất</div>
                  <div className="mt-1 text-base font-bold text-primary">{preview.proposedTag}</div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Ngày công bố: {preview.publishedOn}</div>
                </div>

                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Tác động đến vận hành</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-emerald-600">+{preview.operationalCounts.write} ghi mới/điều chỉnh</span>
                    <span className="text-xs text-rose-500">-{preview.operationalCounts.retire} thu hồi</span>
                    {preview.operationalImpactCounts && preview.operationalImpactCounts.overwrites > 0 && (
                      <span className="text-xs font-bold text-amber-600 dark:text-amber-400">({preview.operationalImpactCounts.overwrites} ghi đè)</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Dải ngày: {preview.rangeStart} → {preview.rangeEnd}</div>
                </div>

                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Bảo vệ lịch ngày</div>
                  <div className="mt-1 text-sm font-semibold text-amber-600 dark:text-amber-400">
                    {preview.skippedDays.length} ngày đã có lịch ngày
                  </div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Giữ nguyên 100%, không ghi đè</div>
                </div>
              </div>

              {/* Publish Kind Explanation Banner */}
              {preview.publishKind === 'noop' && (
                <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3.5 text-xs text-sky-900 dark:text-sky-200 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <span className="text-sm">ℹ</span> Không có thay đổi
                  </div>
                  <p>
                    Bản nháp lịch mùa hiện tại khớp hoàn toàn với phiên bản đã công bố và lịch vận hành. Không có gì cần cập nhật. Nút công bố bị khóa để tránh tạo phiên bản trống.
                  </p>
                </div>
              )}

              {preview.publishKind === 'reapply' && (
                <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 p-3.5 text-xs text-indigo-900 dark:text-indigo-200 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <span className="text-sm">🔄</span> Áp dụng lại lịch mùa
                  </div>
                  <p>
                    Lịch mùa không có chuyến nào thay đổi so với phiên bản trước, nhưng dữ liệu vận hành sẽ được áp dụng và đồng bộ lại theo lịch mùa này.
                  </p>
                </div>
              )}

              {/* Explicit Operational Acknowledgement if required */}
              {preview.requiresOperationalAcknowledgement && (
                <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-amber-600 text-lg font-bold">⚠</span>
                    <div>
                      <div className="text-xs font-bold text-amber-900 dark:text-amber-200">
                        Cần xác nhận ghi đè dữ liệu vận hành
                      </div>
                      <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                        Bản công bố sẽ ghi đè lên các thay đổi đã chỉnh trực tiếp ở phần vận hành ({preview.operationalImpactCounts?.overwrites ?? 0} chuyến bay). Bạn cần xác nhận trước khi công bố.
                      </p>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-200 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={acknowledgedOperational && acknowledgedHash === previewResult?.previewHash}
                      onChange={(e) => {
                        setAcknowledgedOperational(e.target.checked);
                        setAcknowledgedHash(e.target.checked ? (previewResult?.previewHash ?? null) : null);
                      }}
                      disabled={stage === 'committing' || isStale}
                      className="h-4 w-4 rounded border-amber-500 text-amber-600 focus:ring-amber-500"
                    />
                    <span>Tôi xác nhận ghi đè các thay đổi vận hành này theo lịch mùa</span>
                  </label>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                {([
                  ['Ngày sẽ công bố sang vận hành', preview.publishableDays],
                  ['Ngày giữ lịch ngày, không ghi đè', preview.skippedDays],
                ] as const).map(([label, days]) => (
                  <details key={label} className="rounded-lg border border-outline-variant bg-surface-variant/10 p-3">
                    <summary className="cursor-pointer font-semibold text-on-surface">
                      {label} ({days.length} ngày)
                    </summary>
                    {days.length === 0 ? (
                      <div className="mt-2 text-on-surface-variant">Không có ngày nào</div>
                    ) : (
                      <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-on-surface-variant">
                        {formatDayRanges(days).map((range) => <li key={range}>{range}</li>)}
                      </ul>
                    )}
                  </details>
                ))}
              </div>

              {/* Planning Counts Chips */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-2">
                  So sánh lịch mùa
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-emerald-500/15 px-3 py-1 font-semibold text-emerald-700 dark:text-emerald-300">
                    +{preview.planningCounts.added} Thêm mới
                  </span>
                  <span className="rounded-full bg-amber-500/15 px-3 py-1 font-semibold text-amber-700 dark:text-amber-300">
                    ~{preview.planningCounts.modified} Điều chỉnh
                  </span>
                  <span className="rounded-full bg-rose-500/15 px-3 py-1 font-semibold text-rose-700 dark:text-rose-300">
                    -{preview.planningCounts.removed} Xóa
                  </span>
                  <span className="rounded-full bg-slate-500/15 px-3 py-1 font-semibold text-slate-700 dark:text-slate-300">
                    ={preview.planningCounts.unchanged} Giữ nguyên
                  </span>
                  {preview.planningCounts.ambiguous > 0 && (
                    <span className="rounded-full bg-error px-3 py-1 font-semibold text-on-error">
                      ⚠ {preview.planningCounts.ambiguous} Chưa xác định (chặn công bố)
                    </span>
                  )}
                </div>
              </div>

              {/* Diagnostics if any */}
              {preview.diagnostics && preview.diagnostics.length > 0 && (
                <div className="rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error space-y-1">
                  <div className="font-bold">Cảnh báo / Điều kiện chặn công bố ({preview.diagnostics.length}):</div>
                  <ul className="list-disc pl-4 space-y-0.5 max-h-24 overflow-y-auto">
                    {preview.diagnostics.slice(0, 10).map((d, i) => (
                      <li key={i}>{d.code ? formatUiValue(d.code, 'code') : 'Cảnh báo'}: {d.flightKey || d.draftId ? String(d.flightKey || d.draftId) : formatUiRecord(d)}</li>
                    ))}
                    {preview.diagnostics.length > 10 && <li>...và {preview.diagnostics.length - 10} cảnh báo khác</li>}
                  </ul>
                </div>
              )}

              {/* Tabs for Planning Diff vs Effective Operations Impact */}
              <div className="rounded-lg border border-outline-variant overflow-hidden">
                <div className="flex border-b border-outline-variant bg-surface-variant/20 px-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setDiffTab('planning')}
                    className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors ${
                      diffTab === 'planning'
                        ? 'border-primary text-primary font-bold bg-surface'
                        : 'border-transparent text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    So sánh lịch mùa ({diffEntries.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiffTab('operational')}
                    className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                      diffTab === 'operational'
                        ? 'border-primary text-primary font-bold bg-surface'
                        : 'border-transparent text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    <span>Tác động đến vận hành thực tế ({impactEntries.length})</span>
                    {preview.operationalImpactCounts && preview.operationalImpactCounts.overwrites > 0 && (
                      <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-600 font-bold">
                        {preview.operationalImpactCounts.overwrites} ghi đè
                      </span>
                    )}
                  </button>
                </div>

                {diffTab === 'planning' && (
                  <>
                    <div className="bg-surface-variant/30 px-3 py-2 text-xs font-bold text-on-surface flex justify-between items-center">
                      <span>Chi tiết thay đổi lịch mùa ({diffEntries.length} dòng hiển thị)</span>
                      {diffLoading && <span className="text-[11px] text-primary">Đang tải...</span>}
                    </div>
                    <div className="max-h-60 overflow-y-auto overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 bg-surface border-b border-outline-variant text-[11px] text-on-surface-variant font-semibold">
                          <tr>
                            <th className="py-1.5 px-3">Loại</th>
                            <th className="py-1.5 px-3">Ngày</th>
                            <th className="py-1.5 px-3">Chuyến</th>
                            <th className="py-1.5 px-3">Chiều</th>
                            <th className="py-1.5 px-3">Trước thay đổi</th>
                            <th className="py-1.5 px-3">Sau thay đổi</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-variant/40">
                          {diffEntries.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                                Không có thay đổi nào giữa bản nháp hiện tại và phiên bản đã công bố trước đó.
                              </td>
                            </tr>
                          ) : (
                            diffEntries.map((e, idx) => {
                              const isSkipped = preview.skippedDays.includes(e.operational_date);
                              return (
                                <tr key={idx} className="hover:bg-surface-variant/20">
                                  <td className="py-1.5 px-3 font-semibold">
                                    {e.change_type === 'added' && <span className="text-emerald-600">Thêm mới</span>}
                                    {e.change_type === 'modified' && <span className="text-amber-600">Điều chỉnh</span>}
                                    {e.change_type === 'removed' && <span className="text-rose-600">Xóa</span>}
                                  </td>
                                  <td className="py-1.5 px-3 font-mono">
                                    <span>{e.operational_date}</span>
                                    {isSkipped && (
                                      <span className="ml-1.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-300">
                                        Giữ lịch ngày
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-3 font-bold">{formatFlightNumber(e.airline, e.flight_number)}</td>
                                  <td className="py-1.5 px-3">{formatUiValue(e.side, 'side')}</td>
                                  <td className="py-1.5 px-3 text-[11px] text-on-surface-variant max-w-[280px]">
                                    {e.change_type === 'added' ? '—' : formatFlightState(e.before_state)}
                                  </td>
                                  <td className="py-1.5 px-3 text-[11px] text-on-surface font-medium max-w-[320px]">
                                    {e.change_type === 'removed' ? (
                                      <span className="text-rose-600 font-semibold">Đã xóa khỏi lịch mùa</span>
                                    ) : e.change_type === 'modified' ? (
                                      <div className="space-y-0.5">
                                        <div>{formatFlightState(e.after_state)}</div>
                                        <div className="text-[10px] text-amber-700 dark:text-amber-300 font-mono bg-amber-500/10 rounded px-1.5 py-0.5 inline-block">
                                          {formatDiffSummary(e.before_state, e.after_state, e.changed_fields)}
                                        </div>
                                      </div>
                                    ) : (
                                      formatFlightState(e.after_state)
                                    )}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                    {diffHasMore && (
                      <div className="border-t border-outline-variant p-2 text-center bg-surface-variant/10">
                        <button
                          type="button"
                          onClick={() => void loadNextDiffPage()}
                          disabled={diffLoading}
                          className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                        >
                          {diffLoading ? 'Đang tải trang tiếp theo...' : 'Xem thêm thay đổi lịch mùa →'}
                        </button>
                      </div>
                    )}
                    {diffError && <p role="alert" className="p-2 text-sm text-error">Không tải được chi tiết thay đổi: {diffError}</p>}
                  </>
                )}

                {diffTab === 'operational' && (
                  <>
                    <div className="bg-surface-variant/30 px-3 py-2 text-xs font-bold text-on-surface flex justify-between items-center">
                      <span>Tác động đến vận hành thực tế ({impactEntries.length} dòng hiển thị)</span>
                      {impactLoading && <span className="text-[11px] text-primary">Đang tải...</span>}
                    </div>
                    <div className="max-h-60 overflow-y-auto overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 bg-surface border-b border-outline-variant text-[11px] text-on-surface-variant font-semibold">
                          <tr>
                            <th className="py-1.5 px-3">Loại</th>
                            <th className="py-1.5 px-3">Ngày</th>
                            <th className="py-1.5 px-3">Chuyến bay</th>
                            <th className="py-1.5 px-3">Ghi đè vận hành</th>
                            <th className="py-1.5 px-3">Trước thay đổi</th>
                            <th className="py-1.5 px-3">Sau công bố</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-variant/40">
                          {impactEntries.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                                Không có chuyến bay nào bị thay đổi ở phần vận hành.
                              </td>
                            </tr>
                          ) : (
                            impactEntries.map((e, idx) => {
                              const flightCode = formatFlightNumber(
                                e.after_state?.airline ?? e.before_state?.airline,
                                e.after_state?.flight_number ?? e.before_state?.flight_number,
                              );
                              return (
                                <tr key={idx} className="hover:bg-surface-variant/20">
                                  <td className="py-1.5 px-3 font-semibold">
                                    {e.change_type === 'added' && <span className="text-emerald-600">Thêm mới</span>}
                                    {e.change_type === 'modified' && <span className="text-amber-600">Điều chỉnh</span>}
                                    {e.change_type === 'removed' && <span className="text-rose-600">Thu hồi</span>}
                                  </td>
                                  <td className="py-1.5 px-3 font-mono">{e.operational_date}</td>
                                  <td className="py-1.5 px-3 font-bold">{flightCode}</td>
                                  <td className="py-1.5 px-3">
                                    {e.overwrites_operational ? (
                                      <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:text-rose-300">
                                        ⚠ Ghi đè
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-on-surface-variant">Bình thường</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-3 text-[11px] text-on-surface-variant max-w-[280px]">
                                    {e.change_type === 'added' ? '—' : formatFlightState(e.before_state)}
                                  </td>
                                  <td className="py-1.5 px-3 text-[11px] text-on-surface font-medium max-w-[320px]">
                                    {e.change_type === 'removed' ? (
                                      <span className="text-rose-600 font-semibold">Thu hồi khỏi vận hành</span>
                                    ) : e.change_type === 'modified' ? (
                                      <div className="space-y-0.5">
                                        <div>{formatFlightState(e.after_state)}</div>
                                        <div className="text-[10px] text-amber-700 dark:text-amber-300 font-mono bg-amber-500/10 rounded px-1.5 py-0.5 inline-block">
                                          {formatDiffSummary(e.before_state, e.after_state, e.changed_fields)}
                                        </div>
                                      </div>
                                    ) : (
                                      formatFlightState(e.after_state)
                                    )}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                    {impactHasMore && (
                      <div className="border-t border-outline-variant p-2 text-center bg-surface-variant/10">
                        <button
                          type="button"
                          onClick={() => void loadNextImpactPage()}
                          disabled={impactLoading}
                          className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                        >
                          {impactLoading ? 'Đang tải trang tiếp theo...' : 'Xem thêm tác động đến vận hành →'}
                        </button>
                      </div>
                    )}
                    {impactError && <p role="alert" className="p-2 text-sm text-error">Không tải được tác động đến vận hành: {impactError}</p>}
                  </>
                )}
              </div>
              {/* Notes Input */}
              <div>
                <label htmlFor={notesId} className="block text-xs font-medium text-on-surface-variant mb-1">
                  Ghi chú phiên bản (không bắt buộc)
                </label>
                <input
                  id={notesId}
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Ví dụ: Cập nhật giờ bay StarLux và chặng mới mùa W26"
                  className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none"
                />
              </div>

              {errorMessage && (
                <div className="rounded bg-error-container/20 border border-error/30 p-2.5 text-xs text-error">
                  {errorMessage}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {(stage === 'preview' || stage === 'committing') && (
          <footer className="flex items-center justify-between border-t border-outline-variant px-6 py-3.5 bg-surface-variant/10">
            <button
              type="button"
              onClick={onClose}
              disabled={stage === 'committing'}
              className="rounded-lg border border-outline-variant px-4 py-2 text-xs font-semibold text-on-surface hover:bg-surface-variant/30"
            >
              Hủy
            </button>
            {(() => {
              const isNoop = preview?.publishKind === 'noop';
              const isAckRequiredAndMissing = Boolean(preview?.requiresOperationalAcknowledgement) && (!acknowledgedOperational || acknowledgedHash !== previewResult?.previewHash);
              const canCommit = !isBlocked && !isStale && !diffLoading && !impactLoading && !Boolean(diffError) && !Boolean(impactError) && stage !== 'committing' && !isNoop && !isAckRequiredAndMissing;
              const commitButtonLabel = stage === 'committing'
                ? 'Đang công bố...'
                : isBlocked
                ? 'Bị chặn (có lỗi nhận diện chuyến bay)'
                : Boolean(diffError) || Boolean(impactError)
                ? 'Không thể công bố (lỗi tải bản so sánh)'
                : isNoop
                ? 'Không có thay đổi để công bố'
                : preview?.publishKind === 'reapply'
                ? 'Xác nhận áp dụng lại sang vận hành'
                : 'Xác nhận công bố lịch bay';
              return (
                <button
                  type="button"
                  onClick={() => void handleCommit()}
                  disabled={!canCommit}
                  className="rounded-lg bg-primary px-5 py-2 text-xs font-bold text-on-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {commitButtonLabel}
                </button>
              );
            })()}
          </footer>
        )}
      </div>
    </div>
  );
}
