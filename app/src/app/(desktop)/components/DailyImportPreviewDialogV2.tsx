'use client';

import { useEffect, useRef, useState } from 'react';
import type { DailyImportStageResultV2, DailyImportReplacedLegV2 } from '@/lib/operationalScheduleContract';
import { formatUiError, formatUiValue } from '@/lib/uiDisplayText';

function getDiagnosticCode(d: unknown): string {
  if (d && typeof d === 'object' && 'code' in d && typeof d.code === 'string') return d.code;
  return '';
}

function getDiagnosticMessage(d: unknown): string {
  if (d && typeof d === 'object' && 'message' in d && typeof d.message === 'string') return d.message;
  return '';
}

export default function DailyImportPreviewDialogV2({
  result,
  commitEnabled,
  committing,
  restaging = false,
  onCancel,
  onCommit,
  onConfirmZeroFlightDates,
}: {
  result: DailyImportStageResultV2;
  commitEnabled: boolean;
  committing: boolean;
  restaging?: boolean;
  onCancel: () => void;
  onCommit: () => void;
  onConfirmZeroFlightDates?: (dates: string[]) => void;
}) {
  const [zeroFlightInput, setZeroFlightInput] = useState<string>('');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const valid = result.status === 'validated' && result.preview.valid && result.diagnostics.length === 0;
  const needsZeroFlightConfirmation = result.diagnostics.some((diagnostic) => {
    const code = getDiagnosticCode(diagnostic);
    return code === 'DAILY_ZERO_FLIGHT_CONFIRMATION';
  });

  const unavailableMessage =
    result.diagnostics.length === 0 && result.status !== 'validated'
      ? result.status === 'cancelled'
        ? 'Bản xem trước này đã bị hủy. Hãy đóng bản xem trước và chọn lại tệp để tạo đợt nhập mới.'
        : result.status === 'expired'
          ? 'Bản xem trước này đã hết hạn. Hãy đóng bản xem trước và chọn lại tệp để chuẩn bị lại.'
          : result.status === 'committed'
            ? `Đợt nhập đã được lưu. Phiên bản ${result.result?.revision ?? '—'}; ${result.result?.insertedCount ?? 0} chặng bay mới, ${result.result?.replacedCount ?? 0} chặng bay được thay thế. Không cần nhập lại.`
            : 'Đợt nhập không ở trạng thái có thể lưu.'
      : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="daily-import-preview-v2-title"
      aria-describedby="daily-import-preview-v2-summary"
      onCancel={(event) => {
        event.preventDefault();
        if (!committing && !restaging) onCancel();
      }}
      className="m-auto w-full max-w-5xl bg-transparent p-3 backdrop:bg-black/50"
    >
      <section className="max-h-[92dvh] w-full max-w-5xl overflow-y-auto rounded-xl border border-outline-variant bg-surface p-5 text-on-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="daily-import-preview-v2-title" className="text-balance text-xl font-semibold">
              Xem trước thay thế Lịch ngày (vận hành)
            </h2>
            <p id="daily-import-preview-v2-summary" className="mt-1 text-pretty text-sm text-on-surface-variant">
              Đợt nhập: <span className="font-mono text-xs">{result.batchId}</span> · {result.preview.legCount.toLocaleString('vi-VN')} chặng bay trong tệp · {(result.preview.rebaseCount ?? 0).toLocaleString('vi-VN')} điều chỉnh được giữ lại · {(result.preview.replacedCount ?? result.preview.replacedLegsCount ?? (result.preview.replacedLegs ?? []).length).toLocaleString('vi-VN')} chặng bị thay thế
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              valid || result.status === 'committed' ? 'bg-primary-container text-on-primary-container' : 'bg-error-container text-on-error-container'
            }`}
          >
            {result.status === 'committed' ? 'Đã lưu' : valid ? 'Sẵn sàng lưu' : 'Đang bị chặn'}
          </span>
        </div>

        {result.diagnostics.length > 0 && (
          <div className="mt-4 rounded-lg border border-error bg-error-container/40 p-3" role="alert">
            <div className="font-semibold text-on-error-container">Lỗi / Cảnh báo cần xử lý</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-on-error-container">
              {result.diagnostics.slice(0, 20).map((diagnostic, index) => {
                const code = getDiagnosticCode(diagnostic);
                const message = getDiagnosticMessage(diagnostic);
                return <li key={`${code || 'diag'}-${index}`}>{formatUiError(message || code, 'Dữ liệu nhập không hợp lệ')}</li>;
              })}
            </ul>
          </div>
        )}

        {unavailableMessage && (
          <div className={`mt-4 rounded-lg border p-3 text-sm ${result.status === 'committed' ? 'border-primary bg-primary-container text-on-primary-container' : 'border-error bg-error-container/40 text-on-error-container'}`} role="status">
            {unavailableMessage}
          </div>
        )}

        {needsZeroFlightConfirmation && onConfirmZeroFlightDates && (
          <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <h3 className="text-balance text-sm font-semibold">Xác nhận rõ ngày khai thác không có chuyến bay</h3>
            <p className="mt-1 text-pretty text-sm text-on-surface-variant">
              Nhập danh sách ngày khai thác xác nhận không có chuyến bay (YYYY-MM-DD, cách nhau bởi dấu phẩy).
            </p>
            <div className="mt-3">
              <input
                value={zeroFlightInput}
                onChange={(event) => setZeroFlightInput(event.target.value)}
                placeholder="2026-09-28, 2026-09-29"
                autoComplete="off"
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <button
              type="button"
              disabled={restaging || !zeroFlightInput.trim()}
              onClick={() => {
                const dates = zeroFlightInput
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean);
                onConfirmZeroFlightDates(dates);
              }}
              className="mt-3 rounded-lg border border-primary px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {restaging ? 'Đang chuẩn bị lại…' : 'Xác nhận ngày trống và chuẩn bị lại'}
            </button>
          </div>
        )}

        <div className="mt-5 space-y-3">
          <div className="rounded-lg border border-outline-variant bg-surface-container p-3 text-sm">
            <div className="font-semibold text-on-surface">Phạm vi ngày ảnh hưởng:</div>
            <div className="mt-1 flex flex-wrap gap-1.5 font-mono text-xs">
              {result.preview.affectedDates.map((date) => (
                <span key={date} className="rounded bg-surface-container-high px-2 py-0.5 text-on-surface">
                  {date}
                </span>
              ))}
            </div>
            {result.preview.confirmedZeroFlightDates.length > 0 && (
              <div className="mt-2 text-xs text-on-surface-variant">
                Ngày không có chuyến bay đã xác nhận: {result.preview.confirmedZeroFlightDates.join(', ')}
              </div>
            )}
          </div>

          {((result.preview.replacedLegs ?? []).length > 0 || (result.preview.replacedLegsCount ?? 0) > 0 || (result.preview.replacedCount ?? 0) > 0) && (
            <div className="overflow-x-auto rounded-lg border border-outline-variant">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-container-high px-3 py-2 text-xs font-semibold uppercase text-on-surface-variant">
                <span>Chuyến bay bị thay thế ({(result.preview.replacedCount ?? result.preview.replacedLegsCount ?? (result.preview.replacedLegs ?? []).length).toLocaleString('vi-VN')})</span>
                {(result.preview.replacedLegsTruncated || (result.preview.replacedLegs ?? []).length < (result.preview.replacedCount ?? result.preview.replacedLegsCount ?? (result.preview.replacedLegs ?? []).length)) && (
                  <span className="font-normal normal-case text-on-surface-variant">
                    (Đang hiển thị {(result.preview.replacedLegs ?? []).length.toLocaleString('vi-VN')} chuyến mẫu; các chuyến còn lại vẫn được thay thế đầy đủ khi lưu)
                  </span>
                )}
              </div>
              {(result.preview.replacedLegs ?? []).length > 0 ? (
                <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                  <thead className="bg-surface-container text-xs text-on-surface-variant">
                    <tr>
                      <th className="px-3 py-1.5">Ngày</th>
                      <th className="px-3 py-1.5">Loại</th>
                      <th className="px-3 py-1.5">Chuyến</th>
                      <th className="px-3 py-1.5">Giờ</th>
                      <th className="px-3 py-1.5">Chặng</th>
                      <th className="px-3 py-1.5">Nguồn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(result.preview.replacedLegs ?? []).slice(0, 100).map((leg: DailyImportReplacedLegV2) => (
                      <tr key={leg.legId} className="border-t border-outline-variant">
                        <td className="px-3 py-1 font-mono text-xs">{leg.operationalDate}</td>
                        <td className="px-3 py-1">{leg.side === 'ARR' ? 'Đến' : 'Đi'}</td>
                        <td className="px-3 py-1 font-semibold">{leg.flightNumber.startsWith(leg.airline) ? leg.flightNumber : `${leg.airline}${leg.flightNumber}`}</td>
                        <td className="px-3 py-1 font-mono text-xs">{leg.scheduledTime}</td>
                        <td className="px-3 py-1 text-xs">{leg.route}</td>
                        <td className="px-3 py-1 text-xs">{formatUiValue(leg.sourceType, 'sourceType')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-3 text-xs text-on-surface-variant">
                  Có {(result.preview.replacedLegsCount ?? 0).toLocaleString('vi-VN')} chuyến bay hiện hữu trong phạm vi ngày sẽ được thay thế khi lưu.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            autoFocus
            type="button"
            onClick={onCancel}
            disabled={committing || restaging}
            className="rounded-lg border border-outline-variant px-4 py-2 text-sm font-medium hover:bg-surface-container-high disabled:opacity-50"
          >
            Đóng bản xem trước
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={!valid || !commitEnabled || committing || restaging}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {committing ? 'Đang nhập…' : 'Nhập và thay thế'}
          </button>
        </div>
      </section>
    </dialog>
  );
}
