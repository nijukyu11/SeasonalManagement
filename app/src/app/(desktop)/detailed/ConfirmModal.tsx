import React, { useMemo } from 'react';
import type { FlightLeg, FlightModification } from '@/lib/types';
import type { SourceRowOperationPlan } from '@/lib/sourceRowPatterns';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  proposedMods: FlightModification[];
  sourcePlan?: SourceRowOperationPlan | null;
  recordsById: ReadonlyMap<string, FlightLeg>;
  nativeChangeCount: number;
  onConfirm: () => void;
  isSaving: boolean;
  confirmLabel?: string;
  fromDate?: string | null;
  toDate?: string | null;
  visibleDateRange?: {
    fromDate?: string | null;
    toDate?: string | null;
  };
}

export default function ConfirmModal({
  isOpen,
  onClose,
  proposedMods,
  sourcePlan,
  recordsById,
  nativeChangeCount,
  onConfirm,
  isSaving,
  confirmLabel = 'LƯU THAY ĐỔI',
  fromDate,
  toDate,
  visibleDateRange,
}: ConfirmModalProps) {
  const rangeFrom = fromDate ?? visibleDateRange?.fromDate ?? null;
  const rangeTo = toDate ?? visibleDateRange?.toDate ?? null;
  const diffs = useMemo(() => {
    return proposedMods.map(mod => {
      let original = recordsById.get(mod.legId);
      
      if (mod.action === 'added' && mod.addedLeg) {
         original = mod.addedLeg;
      }
      
      if (!original) return null;

      return {
        mod,
        original
      };
    }).filter(Boolean) as { mod: FlightModification, original: FlightLeg }[];
  }, [proposedMods, recordsById]);

  const counts = useMemo(() => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    for (const mod of proposedMods) {
      if (mod.action === 'added') added++;
      else if (mod.action === 'deleted') deleted++;
      else if (mod.action === 'modified') modified++;
    }
    return { added, modified, deleted };
  }, [proposedMods]);

  const reviewCount = sourcePlan ? sourcePlan.preview.length : nativeChangeCount;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-xl w-[600px] max-w-[90vw] overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-6 border-b border-surface-variant bg-surface-container-lowest flex justify-between items-center">
          <div>
            <h2 className="font-h2 text-h2 text-on-surface">Xác nhận thay đổi</h2>
            <p className="font-body-sm text-on-surface-variant mt-1">
              Vui lòng kiểm tra {reviewCount} thay đổi trước khi lưu
              {!sourcePlan && (counts.added > 0 || counts.modified > 0 || counts.deleted > 0) && (
                <span className="ml-1 text-xs">
                  ({[
                    counts.added > 0 ? `${counts.added} thêm mới` : null,
                    counts.modified > 0 ? `${counts.modified} điều chỉnh` : null,
                    counts.deleted > 0 ? `${counts.deleted} xóa` : null,
                  ].filter(Boolean).join(', ')})
                </span>
              )}.
            </p>
          </div>
          {isSaving && <span className="material-symbols-outlined animate-spin text-primary">sync</span>}
        </div>

        <div className="p-0 overflow-y-auto flex-1 bg-surface-container-low">
          {sourcePlan ? (
            <div className="p-4 flex flex-col gap-3">
              {sourcePlan.preview.map((line, index) => (
                <div key={`${line}-${index}`} className="bg-surface rounded border border-surface-variant p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-on-surface">
                    <span className="material-symbols-outlined text-[18px] text-primary">call_split</span>
                    {line}
                  </div>
                </div>
              ))}
              <div className="bg-surface-container-high rounded border border-outline-variant p-3 text-xs text-on-surface-variant">
                Thao tác này giữ nguyên các ngày đã chọn: chỉ tách những ngày bay hiện có thuộc kỳ đã chọn và các thứ khai thác đã đánh dấu.
              </div>
            </div>
          ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-variant sticky top-0">
              <tr>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Chuyến bay</th>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Ngày</th>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Thay đổi</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map(({ mod, original }) => {
                const isOutsideVisibleRange = Boolean(
                  original && (
                    (rangeFrom && original.date < rangeFrom) ||
                    (rangeTo && original.date > rangeTo)
                  )
                );
                return (
                  <tr key={mod.legId} data-flight-id={original.id || mod.legId} data-date={original.date} className="border-b border-surface-variant bg-surface">
                    <td className="p-3 font-medium text-on-surface">
                      <div className="flex items-center gap-1.5">
                        <span>{original.flightNumber}</span>
                        {original.type && (
                          <span className={`text-[10px] font-semibold px-1 rounded ${original.type === 'A' ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'}`}>
                            {original.type}
                          </span>
                        )}
                        {original.route && (
                          <span className="text-xs text-on-surface-variant">({original.route})</span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-on-surface-variant font-data-tabular">
                      <div className="flex flex-col gap-0.5">
                        <span>{original.date}</span>
                        {isOutsideVisibleRange && (
                          <span className="text-[11px] font-medium text-amber-800 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5 w-fit">
                            Ngoài phạm vi đang xem ({original.date})
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 font-data-tabular">
                      {mod.action === 'deleted' && (
                        <span className="text-error bg-error-container/30 px-2 py-1 rounded font-medium text-xs">XÓA</span>
                      )}
                      {mod.action === 'added' && (
                        <span className="text-emerald-600 bg-emerald-100 px-2 py-1 rounded font-medium text-xs">THÊM MỚI</span>
                      )}
                      {mod.action === 'modified' && (
                        <div className="flex flex-col gap-1">
                          {mod.schedule && (
                            <div className="flex items-center gap-2">
                              <span className="text-on-surface-variant line-through">{original.schedule}</span>
                              <span className="material-symbols-outlined text-[14px] text-primary">arrow_right_alt</span>
                              <span className="text-primary font-bold">{mod.schedule}</span>
                            </div>
                          )}
                          {mod.aircraft && (
                            <div className="flex items-center gap-2">
                              <span className="text-on-surface-variant line-through">{original.aircraft}</span>
                              <span className="material-symbols-outlined text-[14px] text-primary">arrow_right_alt</span>
                              <span className="text-primary font-bold">{mod.aircraft}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {diffs.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-6 text-center text-on-surface-variant italic">Không có thay đổi.</td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </div>

        <div className="p-4 border-t border-surface-variant bg-surface-container-lowest flex justify-between gap-3">
          <button 
            onClick={onClose} 
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium text-on-surface hover:bg-surface-variant rounded transition-colors disabled:opacity-50"
          >
            Quay lại
          </button>
          <button 
            onClick={onConfirm} 
            disabled={isSaving || (!sourcePlan && nativeChangeCount === 0) || (!!sourcePlan && sourcePlan.writes.length === 0)}
            className="px-6 py-2 text-sm font-medium bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container rounded transition-colors shadow-sm disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? 'Đang lưu…' : confirmLabel}
          </button>
        </div>

      </div>
    </div>
  );
}
