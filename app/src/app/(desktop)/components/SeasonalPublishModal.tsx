'use client';

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
  previewSeasonalPublishV1,
  getSeasonalPublishPreviewPageV1,
  commitSeasonalPublishV1,
} from '@/lib/remoteStore';
import { useOperationalScheduleStore } from '@/lib/operationalScheduleAdapter';
import type {
  SeasonalPublishPreviewResult,
  SeasonalPublishCommitResult,
  SeasonalPublishedDiffEntry,
} from '@/lib/seasonalPlanningContract';

interface SeasonalPublishModalProps {
  isOpen: boolean;
  seasonId: string;
  seasonCode: string;
  onClose: () => void;
}

// Collapse ISO dates into consecutive runs so a full season stays readable in the modal.
function formatDayRanges(days: string[]): string[] {
  const sorted = Array.from(new Set(days)).sort();
  const ranges: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  const nextDay = (day: string) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  for (const day of sorted) {
    if (start && prev && nextDay(prev) === day) {
      prev = day;
      continue;
    }
    if (start && prev) ranges.push(start === prev ? start : `${start} → ${prev}`);
    start = day;
    prev = day;
  }
  if (start && prev) ranges.push(start === prev ? start : `${start} → ${prev}`);
  return ranges;
}

function formatFlightState(state: Record<string, unknown> | null | undefined): string {
  if (!state) return '—';
  const parts: string[] = [];
  if (state.schedule) parts.push(`Giờ ${String(state.schedule)}`);
  if (state.route) parts.push(`Tuyến ${String(state.route)}`);
  if (state.aircraft) parts.push(`Tàu ${String(state.aircraft)}`);
  if (state.pax !== undefined && state.pax !== null) parts.push(`Pax ${String(state.pax)}`);
  if (state.gate) parts.push(`Cửa ${String(state.gate)}`);
  if (state.stand) parts.push(`Bãi ${String(state.stand)}`);
  if (state.counter) parts.push(`Quầy ${Array.isArray(state.counter) ? state.counter.join(',') : String(state.counter)}`);
  return parts.length > 0 ? parts.join(' · ') : JSON.stringify(state);
}

function formatDiffSummary(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  changedFields?: string[] | null
): string {
  const fieldLabels: Record<string, string> = {
    schedule: 'Giờ',
    route: 'Tuyến',
    aircraft: 'Tàu bay',
    pax: 'Pax',
    gate: 'Cửa',
    stand: 'Bãi',
    counter: 'Quầy',
    carousel: 'Băng chuyền',
    action: 'Hành động',
  };
  const fields = changedFields && changedFields.length > 0
    ? changedFields
    : Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  const diffs: string[] = [];
  for (const f of fields) {
    if (['source_row_index', 'status', 'created_at', 'updated_at'].includes(f)) continue;
    const bVal = before?.[f];
    const aVal = after?.[f];
    if (JSON.stringify(bVal) === JSON.stringify(aVal)) continue;
    const label = fieldLabels[f] ?? f;
    const bStr = bVal === undefined || bVal === null ? '—' : Array.isArray(bVal) ? bVal.join(',') : String(bVal);
    const aStr = aVal === undefined || aVal === null ? '—' : Array.isArray(aVal) ? aVal.join(',') : String(aVal);
    diffs.push(`${label}: ${bStr} → ${aStr}`);
  }
  return diffs.length > 0 ? diffs.join(' · ') : '—';
}

export default function SeasonalPublishModal({
  isOpen,
  seasonId,
  seasonCode,
  onClose,
}: SeasonalPublishModalProps) {
  const [stage, setStage] = useState<'loading' | 'preview' | 'committing' | 'committed' | 'error'>('loading');
  const [previewResult, setPreviewResult] = useState<SeasonalPublishPreviewResult | null>(null);
  const [diffEntries, setDiffEntries] = useState<SeasonalPublishedDiffEntry[]>([]);
  const [diffPageSize] = useState(20);
  const [diffHasMore, setDiffHasMore] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
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
    setErrorMessage(null);
    setIsStale(false);
    setDiffLoading(true);
    try {
      const result = await previewSeasonalPublishV1({ seasonId, requestId: crypto.randomUUID() });
      if (generation !== requestGeneration.current) return;
      setPreviewResult(result);
      const page = await getSeasonalPublishPreviewPageV1({
        previewId: result.previewId,
        previewHash: result.previewHash,
        afterIndex: 0,
        pageSize: diffPageSize,
      });
      if (generation !== requestGeneration.current) return;
      setDiffEntries(page.entries);
      setDiffHasMore(page.hasMore);
      setIsStale(Boolean(page.stale));
      setStage('preview');
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setStage('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
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
        setNotes('');
        setCommitResult(null);
        setErrorMessage(null);
        setIsStale(false);
      });
    }
    return () => { requestGeneration.current += 1; };
  }, [isOpen, loadPreview]);

  useEffect(() => {
    if (stage !== 'committing') return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
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
        setDiffError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === requestGeneration.current) setDiffLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!previewResult || previewResult.status !== 'ready' || stage !== 'preview' || isStale || diffLoading || diffError || committing.current) return;
    committing.current = true;
    setStage('committing');
    setErrorMessage(null);
    try {
      const result = await commitSeasonalPublishV1({
        seasonId,
        previewId: previewResult.previewId,
        previewHash: previewResult.previewHash,
        notes,
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
        setErrorMessage('Dữ liệu kế hoạch mùa hoặc phạm vi Daily đã thay đổi. Vui lòng tải lại diff.');
      } else {
        setErrorMessage(errObj.message || 'Lỗi công bố lịch bay.');
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
              Công bố Lịch bay Mùa — Cổng Versioning & Operations
            </h2>
            <p className="mt-0.5 text-xs text-on-surface-variant">
              Mùa: <span className="font-semibold text-primary">{seasonCode}</span> · CSDL Kế hoạch (Planning) sang CSDL Vận hành (Operations)
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
              <p className="mt-3 text-sm text-on-surface-variant font-medium">Đang tính toán Diff & đối soát phạm vi Daily...</p>
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
                <div>Chuyến nạp vận hành: <strong>{commitResult.operationalCounts.write}</strong></div>
                <div>Chuyến thu hồi: <strong>{commitResult.operationalCounts.retire}</strong></div>
                <div>Ngày Daily bảo toàn: <strong>{commitResult.skippedDays.length} ngày</strong></div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-4 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-on-primary hover:bg-primary/90"
              >
                Hoàn tất & Đóng
              </button>
            </div>
          )}

          {(stage === 'preview' || stage === 'committing') && preview && (
            <>
              {isStale && (
                <div className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                  <span>Dữ liệu đã thay đổi kể từ lần tạo bản so sánh này. Vui lòng tải lại diff trước khi công bố.</span>
                  <button
                    type="button"
                    onClick={() => void loadPreview()}
                    className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    Tải lại Diff
                  </button>
                </div>
              )}

              {/* Version & Tag preview card */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Version Tag đề xuất</div>
                  <div className="mt-1 text-base font-bold text-primary">{preview.proposedTag}</div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Ngày phát hành: {preview.publishedOn}</div>
                </div>

                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Tác động Vận hành (Operations)</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-emerald-600">+{preview.operationalCounts.write} nạp mới/sửa</span>
                    <span className="text-xs text-rose-500">-{preview.operationalCounts.retire} thu hồi</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Dải ngày: {preview.rangeStart} → {preview.rangeEnd}</div>
                </div>

                <div className="rounded-lg border border-outline-variant bg-surface-variant/20 p-3">
                  <div className="text-xs text-on-surface-variant">Bảo vệ Chân lý Daily (AMS)</div>
                  <div className="mt-1 text-sm font-semibold text-amber-600 dark:text-amber-400">
                    {preview.skippedDays.length} ngày đã có Daily
                  </div>
                  <div className="mt-0.5 text-[11px] text-on-surface-variant">Bảo toàn nguyên vẹn 100%, không ghi đè</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                {([
                  ['Ngày sẽ công bố sang Vận hành', preview.publishableDays],
                  ['Ngày giữ Daily, không ghi đè', preview.skippedDays],
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
                  So sánh Kế hoạch (Planning Diff)
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-emerald-500/15 px-3 py-1 font-semibold text-emerald-700 dark:text-emerald-300">
                    +{preview.planningCounts.added} Thêm mới
                  </span>
                  <span className="rounded-full bg-amber-500/15 px-3 py-1 font-semibold text-amber-700 dark:text-amber-300">
                    ~{preview.planningCounts.modified} Sửa đổi
                  </span>
                  <span className="rounded-full bg-rose-500/15 px-3 py-1 font-semibold text-rose-700 dark:text-rose-300">
                    -{preview.planningCounts.removed} Xóa bỏ
                  </span>
                  <span className="rounded-full bg-slate-500/15 px-3 py-1 font-semibold text-slate-700 dark:text-slate-300">
                    ={preview.planningCounts.unchanged} Giữ nguyên
                  </span>
                  {preview.planningCounts.ambiguous > 0 && (
                    <span className="rounded-full bg-error px-3 py-1 font-semibold text-on-error">
                      ⚠ {preview.planningCounts.ambiguous} Không xác định (Chặn)
                    </span>
                  )}
                </div>
              </div>

              {/* Diagnostics if any */}
              {preview.diagnostics && preview.diagnostics.length > 0 && (
                <div className="rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error space-y-1">
                  <div className="font-bold">Cảnh báo / Rào cản công bố ({preview.diagnostics.length}):</div>
                  <ul className="list-disc pl-4 space-y-0.5 max-h-24 overflow-y-auto">
                    {preview.diagnostics.slice(0, 10).map((d, i) => (
                      <li key={i}>{String(d.code || 'DIAGNOSTIC')}: {String(d.flightKey || d.draftId || JSON.stringify(d))}</li>
                    ))}
                    {preview.diagnostics.length > 10 && <li>...và {preview.diagnostics.length - 10} cảnh báo khác</li>}
                  </ul>
                </div>
              )}

              {/* Diff Viewer Table */}
              <div className="rounded-lg border border-outline-variant overflow-hidden">
                <div className="bg-surface-variant/30 px-3 py-2 text-xs font-bold text-on-surface flex justify-between items-center">
                  <span>Chi tiết thay đổi ({diffEntries.length} dòng hiển thị)</span>
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
                        <th className="py-1.5 px-3">Trạng thái trước</th>
                        <th className="py-1.5 px-3">Trạng thái sau</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/40">
                      {diffEntries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                            Không có thay đổi nào giữa bản nháp hiện tại và phiên bản công bố trước.
                          </td>
                        </tr>
                      ) : (
                        diffEntries.map((e, idx) => (
                          <tr key={idx} className="hover:bg-surface-variant/20">
                            <td className="py-1.5 px-3 font-semibold">
                              {e.change_type === 'added' && <span className="text-emerald-600">Thêm mới</span>}
                              {e.change_type === 'modified' && <span className="text-amber-600">Sửa đổi</span>}
                              {e.change_type === 'removed' && <span className="text-rose-600">Xóa</span>}
                            </td>
                            <td className="py-1.5 px-3 font-mono">{e.operational_date}</td>
                            <td className="py-1.5 px-3 font-bold">{e.airline}{e.flight_number}</td>
                            <td className="py-1.5 px-3">{e.side}</td>
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
                        ))
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
                      {diffLoading ? 'Đang tải trang kế tiếp...' : 'Xem thêm dòng thay đổi →'}
                    </button>
                  </div>
                )}
              </div>
              {diffError && <p role="alert" className="text-sm text-error">Không tải được chi tiết thay đổi: {diffError}. Vui lòng thử tải trang kế tiếp lại trước khi công bố.</p>}

              {/* Notes Input */}
              <div>
                <label htmlFor={notesId} className="block text-xs font-medium text-on-surface-variant mb-1">
                  Ghi chú phiên bản (Tùy chọn)
                </label>
                <input
                  id={notesId}
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Ví dụ: Cập nhật giờ bay StarLux và chặng mới W26"
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
              Hủy bỏ
            </button>
            <button
              type="button"
              onClick={() => void handleCommit()}
              disabled={isBlocked || isStale || diffLoading || Boolean(diffError) || stage === 'committing'}
              className="rounded-lg bg-primary px-5 py-2 text-xs font-bold text-on-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {stage === 'committing' ? 'Đang phát hành...' : isBlocked ? 'Bị chặn (Có lỗi danh tính)' : 'Xác nhận Công bố Lịch bay'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
