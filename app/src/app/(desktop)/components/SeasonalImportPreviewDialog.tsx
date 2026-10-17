'use client';

import { useState, useEffect, useRef } from 'react';
import type { SeasonalImportPreviewState } from '@/lib/seasonalImportPreview';
import { canCommitSeasonalImportPreview } from '@/lib/seasonalImportPreview';
import type { SeasonalDraftImportEntry } from '@/lib/seasonalDraftImportContract';
import { getSeasonalDraftImportPreviewV1 } from '@/lib/remoteStore';
import { formatUiError, formatUiFieldLabel } from '@/lib/uiDisplayText';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from '@/lib/operatorSessionCacheRegistry';

type PreviewDialogState = Extract<
  SeasonalImportPreviewState,
  { kind: 'preview' | 'committing' }
>;

interface DiagnosticItem {
  code: string;
  message: string;
  occurrenceKey?: string | null;
}

interface WarningItem {
  code: string;
  message: string;
  occurrenceKey?: string | null;
  affectedDateCount?: number;
  sampleDates?: string[];
}

interface SeasonalImportPreviewDialogProps {
  state: PreviewDialogState | null;
  hasDraftChanges: boolean;
  busy: boolean;
  onConfirmationChange: (confirmation: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}

function groupByCode<T extends { code: string }>(items: readonly T[]): Map<string, T[]> {
  return items.reduce<Map<string, T[]>>((groups, item) => {
    const current = groups.get(item.code) ?? [];
    current.push(item);
    groups.set(item.code, current);
    return groups;
  }, new Map());
}

export default function SeasonalImportPreviewDialog({
  state,
  hasDraftChanges,
  busy,
  onConfirmationChange,
  onCancel,
  onCommit,
}: SeasonalImportPreviewDialogProps) {
  const [previewEntries, setPreviewEntries] = useState<SeasonalDraftImportEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextDraftId, setNextDraftId] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const [showDeletedList, setShowDeletedList] = useState(false);

  const batchId = state?.result.batchId;
  const previewBatchIdRef = useRef(batchId);
  previewBatchIdRef.current = batchId;

  useEffect(() => {
    if (!batchId) {
      setPreviewEntries([]);
      setHasMore(false);
      setNextDraftId(null);
      setIsStale(false);
      setEntriesError(null);
      return;
    }
    let cancelled = false;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setPreviewEntries([]);
    setHasMore(false);
    setNextDraftId(null);
    setEntriesLoading(true);
    setEntriesError(null);
    setIsStale(false);

    getSeasonalDraftImportPreviewV1({ batchId, pageSize: 100 })
      .then((page) => {
        if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
        if (page.stale) {
          setIsStale(true);
        }
        setPreviewEntries(page.entries ?? []);
        setHasMore(Boolean(page.hasMore));
        setNextDraftId(page.nextDraftId ?? null);
      })
      .catch((err) => {
        if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
        setEntriesError(formatUiError(err) || 'Không thể tải chi tiết thay đổi');
      })
      .finally(() => {
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setEntriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, reloadTrigger]);

  const handleLoadMore = async () => {
    if (!batchId || !nextDraftId || entriesLoading) return;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setEntriesLoading(true);
    setEntriesError(null);
    try {
      const page = await getSeasonalDraftImportPreviewV1({
        batchId,
        afterDraftId: nextDraftId,
        pageSize: 100,
      });
      if (previewBatchIdRef.current !== batchId || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      if (page.stale) {
        setIsStale(true);
      }
      setPreviewEntries((prev) => [...prev, ...(page.entries ?? [])]);
      setHasMore(Boolean(page.hasMore));
      setNextDraftId(page.nextDraftId ?? null);
    } catch (err) {
      if (previewBatchIdRef.current !== batchId || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      setEntriesError(formatUiError(err) || 'Không thể tải thêm danh sách chi tiết');
    } finally {
      if (previewBatchIdRef.current === batchId && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setEntriesLoading(false);
    }
  };

  if (!state) return null;
  const { result } = state;
  const confirmation = state.kind === 'preview' ? state.confirmation : '';
  const commitEnabled = canCommitSeasonalImportPreview({
    state,
    hasDraftChanges,
    busy,
    previewError: Boolean(entriesError) || entriesLoading,
    isStale,
  });

  const diagnostics = (result.diagnostics || []) as DiagnosticItem[];
  const warnings = (result.warnings || []) as WarningItem[];
  const diagnosticsByCode = groupByCode(diagnostics);
  const warningsByCode = groupByCode(warnings);

  const counts = result.counts;
  const insertCount = counts.insertCount ?? 0;
  const baselineUpdateCount = counts.baselineUpdateCount ?? 0;
  const unchangedCount = counts.unchangedCount ?? 0;
  const removeImportedCount = counts.removeImportedCount ?? 0;
  const supersedeManualCount = counts.supersedeManualCount ?? 0;
  const totalRemovedCount = removeImportedCount + supersedeManualCount;
  const preservedOutsideScopeCount = counts.preservedOutsideScopeCount ?? 0;
  const unlinkCount = counts.unlinkCount ?? 0;

  const deletedEntries = previewEntries.filter((e) => e.operation === 'delete');

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-scrim/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="seasonal-import-preview-title"
    >
      <div className="my-auto w-full max-w-3xl overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-outline-variant px-5 py-4">
          <div className="min-w-0">
            <h2 id="seasonal-import-preview-title" className="text-lg font-semibold text-on-surface">
              Xem trước dữ liệu nhập lịch mùa (Planning)
            </h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Mùa {result.seasonCode} · {counts.sourceRowCount ?? 0} dòng nguồn · {counts.generatedOccurrenceCount ?? 0} lượt bay
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={state.kind === 'committing'}
            className="grid size-9 shrink-0 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
            aria-label="Hủy xem trước nhập dữ liệu"
            title="Hủy"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </header>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {/* Stale Warning Notice */}
          {isStale && (
            <div className="rounded-lg border border-error/40 bg-error-container/40 p-4 text-sm text-error">
              <div className="flex items-center gap-2 font-semibold">
                <span className="material-symbols-outlined text-[18px]">error</span>
                Bản xem trước đã hết hạn hoặc bản nháp trên máy chủ đã thay đổi
              </div>
              <p className="mt-1 text-xs text-on-surface">
                Bản nháp mùa đã thay đổi trên máy chủ sau khi tạo bản xem trước này. Vui lòng bấm &ldquo;Hủy&rdquo; và nạp lại tệp để bảo đảm tính toàn vẹn dữ liệu.
              </p>
            </div>
          )}

          {/* Detail Fetch Error Notice */}
          {entriesError && (
            <div className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error-container/30 p-3 text-sm text-error sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-semibold">Lỗi tải chi tiết thay đổi</div>
                <div className="mt-0.5 break-all text-xs text-on-surface-variant">{entriesError}</div>
              </div>
              <button
                type="button"
                onClick={() => setReloadTrigger((prev) => prev + 1)}
                disabled={entriesLoading}
                className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-error px-2.5 py-1 text-xs font-semibold text-on-error hover:bg-error/90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                Thử lại
              </button>
            </div>
          )}

          {/* Full Season Scope Notice */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-950 dark:text-amber-100">
            <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
              <span className="material-symbols-outlined text-[18px]">warning</span>
              Nhập toàn bộ lịch mùa vào bản nháp Planning
            </div>
            <p className="mt-1.5 leading-relaxed text-on-surface">
              Tệp Excel đại diện cho <strong>toàn bộ lịch bay của mùa {result.seasonCode}</strong>.
              Mọi chuyến bay trong bản nháp mùa hiện tại không có trong tệp (bao gồm cả các chuyến thêm thủ công)
              sẽ bị loại bỏ khỏi bản nháp. Các điều chỉnh tài nguyên phù hợp sẽ được giữ lại.
            </p>
            <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">
              Các chỉnh sửa bản nháp chưa công bố có thể bị thay thế. Hệ thống phiên bản lịch sử chỉ áp dụng và phục hồi các bản đã Công bố (Publish) sang Vận hành.
            </p>
          </div>

          {/* Counts Grid */}
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-outline-variant bg-outline-variant sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Thêm mới</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{insertCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Cập nhật dữ liệu gốc</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{baselineUpdateCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Không thay đổi</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{unchangedCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Chuyến bay bản nháp bị xóa (gồm thủ công)</span>
              <span className={`tabular-nums text-sm font-semibold ${totalRemovedCount > 0 ? 'text-error' : 'text-on-surface'}`}>
                {totalRemovedCount}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Giữ nguyên ngoài phạm vi</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{preservedOutsideScopeCount}</span>
            </div>
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Hủy liên kết cặp chuyến</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{unlinkCount}</span>
            </div>
          </div>

          {/* Deleted Flights Details List */}
          {totalRemovedCount > 0 && (
            <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-on-surface">
                  Danh sách chuyến bay bản nháp sẽ bị xóa ({totalRemovedCount})
                </span>
                <button
                  type="button"
                  onClick={() => setShowDeletedList((prev) => !prev)}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  {showDeletedList ? 'Thu gọn' : 'Xem chi tiết'}
                </button>
              </div>
              {showDeletedList && (
                <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                  {entriesLoading ? (
                    <div className="text-xs text-on-surface-variant">Đang tải danh sách chuyến bay bị xóa…</div>
                  ) : deletedEntries.length === 0 ? (
                    <div className="text-xs text-on-surface-variant">
                      {totalRemovedCount} chuyến bay vắng mặt trong tệp sẽ bị xóa khi áp dụng.
                    </div>
                  ) : (
                    deletedEntries.map((entry) => {
                      const before = entry.before_state ?? {};
                      const flightNumber = String(before.flight_number || '');
                      const date = String(before.date || '');
                      const route = String(before.route || '');
                      const type = String(before.type || '');
                      const isManual = before.source_kind === 'manual';
                      return (
                        <div
                          key={entry.draft_id}
                          className="flex items-center justify-between rounded bg-surface px-2.5 py-1.5 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-error">
                              {flightNumber}
                            </span>
                            <span className="text-on-surface-variant">
                              {type === 'A' ? 'Đến' : 'Đi'} · {route} · {date}
                            </span>
                          </div>
                          {isManual && (
                            <span className="rounded bg-tertiary-container/50 px-1.5 py-0.5 text-[10px] font-semibold text-on-tertiary-container">
                              Thủ công
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                  {hasMore && (
                    <div className="pt-2 text-center">
                      <button
                        type="button"
                        onClick={() => { void handleLoadMore(); }}
                        disabled={entriesLoading}
                        className="inline-flex items-center gap-1 rounded border border-outline bg-surface px-3 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container disabled:opacity-50"
                      >
                        {entriesLoading ? (
                          <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-[14px]">expand_more</span>
                        )}
                        Tải thêm danh sách (đang hiển thị {previewEntries.length} mục)
                      </button>
                    </div>
                  )}
                  {!hasMore && deletedEntries.length > 0 && deletedEntries.length < totalRemovedCount && (
                    <div className="pt-1 text-center text-xs text-on-surface-variant">
                      …và {totalRemovedCount - deletedEntries.length} chuyến bay khác
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Blocking Diagnostics */}
          {diagnosticsByCode.size > 0 && (
            <section aria-labelledby="seasonal-import-diagnostics">
              <h3 id="seasonal-import-diagnostics" className="text-sm font-semibold text-error">
                Lỗi chặn nhập ({result.diagnosticCount})
              </h3>
              <div className="mt-2 space-y-3">
                {Array.from(diagnosticsByCode.entries()).map(([code, items]) => (
                  <div key={code} className="rounded-lg border border-error/30 bg-error-container/30 p-3">
                    <div className="text-xs font-semibold uppercase text-error">{formatUiFieldLabel(code)}</div>
                    <div className="mt-2 space-y-2">
                      {items.map((diagnostic, index) => (
                        <div key={`${code}-${index}`} className="text-sm text-on-surface">
                          <div>{formatUiError(diagnostic.message)}</div>
                          {diagnostic.occurrenceKey && (
                            <div className="mt-1 break-all font-mono text-xs text-on-surface-variant">
                              {diagnostic.occurrenceKey}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Resolved Warnings */}
          {warningsByCode.size > 0 && (
            <section aria-labelledby="seasonal-import-warnings">
              <h3 id="seasonal-import-warnings" className="text-sm font-semibold text-tertiary">
                Cảnh báo đã tự xử lý ({result.warningCount})
              </h3>
              <p className="mt-1 text-sm text-on-surface-variant">
                Các dòng này đã được tự xử lý khi chuẩn bị tệp; vẫn có thể tiếp tục nhập.
              </p>
              <div className="mt-2 space-y-3">
                {Array.from(warningsByCode.entries()).map(([code, items]) => (
                  <div key={code} className="rounded-lg border border-tertiary/40 bg-tertiary-container/20 p-3">
                    <div className="text-xs font-semibold uppercase text-tertiary">{formatUiFieldLabel(code)}</div>
                    <div className="mt-2 space-y-2">
                      {items.map((warning, index) => (
                        <div key={`${code}-${index}`} className="text-sm text-on-surface">
                          <div>{formatUiError(warning.message)}</div>
                          {warning.sampleDates && warning.sampleDates.length > 0 && (
                            <div className="mt-1 font-mono text-xs text-on-surface-variant">
                              {warning.sampleDates.join(', ')}
                              {warning.affectedDateCount && warning.affectedDateCount > warning.sampleDates.length
                                ? ` +${warning.affectedDateCount - warning.sampleDates.length} ngày khác`
                                : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {result.warningsTruncated && (
                <p className="mt-2 text-xs text-on-surface-variant">
                  Đang hiển thị {warnings.length} trên tổng số {result.warningCount} cảnh báo.
                </p>
              )}
            </section>
          )}

          {/* Explicit Season Code Confirmation */}
          <div className="space-y-2 rounded-lg border border-outline-variant bg-surface-container-low p-4">
            <label className="block">
              <span className="text-sm font-semibold text-on-surface">
                Xác nhận mã mùa ({result.seasonCode}) để áp dụng nhập toàn bộ mùa vào bản nháp:
              </span>
              <input
                type="text"
                value={confirmation}
                onChange={(event) => onConfirmationChange(event.target.value)}
                disabled={state.kind === 'committing'}
                placeholder={result.seasonCode}
                autoComplete="off"
                className="mt-2 w-full rounded-md border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              />
            </label>
            {confirmation.length > 0 && confirmation !== result.seasonCode && (
              <p className="text-xs text-error">
                Mã xác nhận chưa khớp với mã mùa &ldquo;{result.seasonCode}&rdquo;.
              </p>
            )}
          </div>

          {hasDraftChanges && (
            <p className="text-sm font-medium text-error">
              Hãy lưu hoặc hủy các thay đổi bản nháp đang chờ trước khi áp dụng dữ liệu nhập này.
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={state.kind === 'committing'}
            className="rounded-md border border-outline px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={!commitEnabled}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.kind === 'committing' && (
              <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            )}
            {state.kind === 'committing' ? 'Đang nhập…' : 'Áp dụng vào bản nháp'}
          </button>
        </footer>
      </div>
    </div>
  );
}
