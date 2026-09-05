'use client';

import { useEffect, useRef, useState } from 'react';
import { dailyImportPreviewTotalsV1, type DailyImportStageResultV1 } from '@/lib/dailyImportRpcContract';

export default function DailyImportPreviewDialog({
  result,
  commitEnabled,
  committing,
  restaging = false,
  onCancel,
  onCommit,
  onConfirmZeroFlightDates,
}: {
  result: DailyImportStageResultV1;
  commitEnabled: boolean;
  committing: boolean;
  restaging?: boolean;
  onCancel: () => void;
  onCommit: () => void;
  onConfirmZeroFlightDates?: (datesBySeasonId: Record<string, string[]>) => void;
}) {
  const [zeroFlightInputs, setZeroFlightInputs] = useState<Record<string, string>>({});
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const valid = result.status === 'validated' && result.preview.valid && result.diagnostics.length === 0;
  const needsZeroFlightConfirmation = result.diagnostics.some((diagnostic) => diagnostic.code === 'DAILY_COVERAGE_GAP');
  const unavailableMessage = result.diagnostics.length === 0 && result.status !== 'validated'
    ? result.status === 'cancelled'
      ? 'Preview này đã bị hủy. Đóng preview và chọn lại file; ứng dụng sẽ tự tạo batch mới.'
      : result.status === 'expired'
        ? 'Preview này đã hết hạn. Đóng preview và chọn lại file để stage lại.'
        : result.status === 'committed'
          ? 'Batch này đã được commit.'
          : 'Batch không ở trạng thái có thể commit.'
    : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} role="alertdialog" aria-labelledby="daily-import-preview-title" aria-describedby="daily-import-preview-summary"
      onCancel={(event) => { event.preventDefault(); if (!committing && !restaging) onCancel(); }}
      className="m-auto w-full max-w-5xl bg-transparent p-3 backdrop:bg-black/50">
      <section
        className="max-h-[92dvh] w-full max-w-5xl overflow-y-auto rounded-xl border border-outline-variant bg-surface p-5 text-on-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="daily-import-preview-title" className="text-balance text-xl font-semibold">Preview thay thế Daily Schedule</h2>
            <p id="daily-import-preview-summary" className="mt-1 text-pretty text-sm text-on-surface-variant">
              {result.preview.fileName} · {result.preview.workbookProfile} · {result.preview.sourceRowCount} dòng · {result.preview.legCount} legs
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${valid ? 'bg-primary-container text-on-primary-container' : 'bg-error-container text-on-error-container'}`}>
            {valid ? 'Sẵn sàng commit' : 'Đang bị chặn'}
          </span>
        </div>

        {result.diagnostics.length > 0 && (
          <div className="mt-4 rounded-lg border border-error bg-error-container/40 p-3" role="alert">
            <div className="font-semibold text-on-error-container">Lỗi cần xử lý trong file</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-on-error-container">
              {result.diagnostics.slice(0, 20).map((diagnostic, index) => (
                <li key={`${String(diagnostic.code)}-${index}`}>{String(diagnostic.message ?? diagnostic.code ?? 'Invalid import data')}</li>
              ))}
            </ul>
          </div>
        )}

        {unavailableMessage && (
          <div className="mt-4 rounded-lg border border-error bg-error-container/40 p-3 text-sm text-on-error-container" role="alert">
            {unavailableMessage}
          </div>
        )}

        {needsZeroFlightConfirmation && onConfirmZeroFlightDates && (
          <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <h3 className="text-balance text-sm font-semibold">Xác nhận rõ Ops Date không có chuyến bay</h3>
            <p className="mt-1 text-pretty text-sm text-on-surface-variant">
              Nhập các ngày cần thay thế thành zero-flight, cách nhau bằng dấu phẩy. Tên file không được dùng để tự suy phạm vi xóa.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {result.preview.seasons.map((season) => (
                <label key={season.seasonId} className="text-sm font-medium">
                  {season.seasonCode}
                  <input
                    value={zeroFlightInputs[season.seasonId] ?? ''}
                    onChange={(event) => setZeroFlightInputs((current) => ({ ...current, [season.seasonId]: event.target.value }))}
                    placeholder="2026-08-24, 2026-08-25"
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              disabled={restaging || Object.values(zeroFlightInputs).every((value) => value.trim() === '')}
              onClick={() => onConfirmZeroFlightDates(Object.fromEntries(Object.entries(zeroFlightInputs).map(([seasonId, value]) => [seasonId, value.split(',').map((date) => date.trim()).filter(Boolean)])))}
              className="mt-3 rounded-lg border border-primary px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {restaging ? 'Đang stage lại…' : 'Xác nhận ngày trống và stage lại'}
            </button>
          </div>
        )}

        <div className="mt-5 overflow-x-auto rounded-lg border border-outline-variant">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-surface-container-high text-xs uppercase text-on-surface-variant">
              <tr>
                <th className="px-3 py-2">Season</th><th className="px-3 py-2">Ops Date</th><th className="px-3 py-2 text-right">Chuyến trước</th>
                <th className="px-3 py-2 text-right">Chuyến trong file</th><th className="px-3 py-2 text-right">Chuyến sau overlay</th>
                <th className="px-3 py-2 text-right">Pax trước</th><th className="px-3 py-2 text-right">Pax trong file</th><th className="px-3 py-2 text-right">Pax sau overlay</th>
                <th className="px-3 py-2 text-right">Nguồn bị thay</th><th className="px-3 py-2 text-right">Overlay rebase</th><th className="px-3 py-2">Ngày ảnh hưởng</th>
              </tr>
            </thead>
            <tbody>
              {result.preview.seasons.map((season) => {
                const totals = dailyImportPreviewTotalsV1(season.counts);
                return (
                <tr key={season.seasonId} className="border-t border-outline-variant">
                  <td className="px-3 py-2 font-semibold">{season.seasonCode}</td>
                  <td className="px-3 py-2 font-mono text-xs">{season.rangeStart}..{season.rangeEnd}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{season.counts.beforeCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{season.counts.afterCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.effectiveCount ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.beforePax ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.importedPax ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.effectivePax ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums" title="Seasonal / Daily / Manual">{season.counts.seasonalBeforeCount ?? 0}/{season.counts.dailyBeforeCount ?? 0}/{season.counts.manualBeforeCount ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{season.counts.overlayRebaseCount ?? 0}</td>
                  <td className="max-w-[320px] px-3 py-2 text-xs">{season.affectedDates.join(', ')}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button autoFocus type="button" onClick={onCancel} disabled={committing || restaging} className="rounded-lg border border-outline-variant px-4 py-2 text-sm font-medium hover:bg-surface-container-high disabled:opacity-50">Đóng preview</button>
          <button type="button" onClick={onCommit} disabled={!valid || !commitEnabled || committing || restaging} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {committing ? 'Đang commit…' : 'Commit thay thế atomic'}
          </button>
        </div>
      </section>
    </dialog>
  );
}
