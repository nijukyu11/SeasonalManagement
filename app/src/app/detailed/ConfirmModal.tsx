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
}

export default function ConfirmModal({ isOpen, onClose, proposedMods, sourcePlan, recordsById, nativeChangeCount, onConfirm, isSaving, confirmLabel = 'SAVE CHANGES' }: ConfirmModalProps) {
  
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

  const reviewCount = sourcePlan ? sourcePlan.preview.length : nativeChangeCount;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-xl w-[600px] max-w-[90vw] overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-6 border-b border-surface-variant bg-surface-container-lowest flex justify-between items-center">
          <div>
            <h2 className="font-h2 text-h2 text-on-surface">Confirm Changes</h2>
            <p className="font-body-sm text-on-surface-variant mt-1">
              Please review {reviewCount} changes before saving.
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
                This source-row operation preserves exact dates by splitting only existing matching flight dates inside the selected period and checked operating days.
              </div>
            </div>
          ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-variant sticky top-0">
              <tr>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Flight</th>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Date</th>
                <th className="p-3 font-label-caps text-label-caps text-on-surface-variant">Change</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map(({ mod, original }) => (
                <tr key={mod.legId} className="border-b border-surface-variant bg-surface">
                  <td className="p-3 font-medium text-on-surface">
                    {original.flightNumber}
                  </td>
                  <td className="p-3 text-on-surface-variant">
                    {original.date}
                  </td>
                  <td className="p-3 font-data-tabular">
                    {mod.action === 'deleted' && (
                      <span className="text-error bg-error-container/30 px-2 py-1 rounded font-medium text-xs">DELETED</span>
                    )}
                    {mod.action === 'added' && (
                      <span className="text-emerald-600 bg-emerald-100 px-2 py-1 rounded font-medium text-xs">ADDED</span>
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
                        {/* We could also display link changes here later */}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {diffs.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-6 text-center text-on-surface-variant italic">No changes.</td>
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
            Back
          </button>
          <button 
            onClick={onConfirm} 
            disabled={isSaving || (!sourcePlan && nativeChangeCount === 0) || (!!sourcePlan && sourcePlan.writes.length === 0)}
            className="px-6 py-2 text-sm font-medium bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container rounded transition-colors shadow-sm disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? 'Saving...' : confirmLabel}
          </button>
        </div>

      </div>
    </div>
  );
}
