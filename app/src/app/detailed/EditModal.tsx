import React, { useState, useEffect } from 'react';
import type { FlightLeg, FlightModification } from '@/lib/types';

interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  targetLegs: FlightLeg[]; // The legs targeted for editing
  onNext: (mods: FlightModification[]) => void;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function EditModal({ isOpen, onClose, title, targetLegs, onNext }: EditModalProps) {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [newSchedule, setNewSchedule] = useState('');
  const [newAircraft, setNewAircraft] = useState('');
  const [newCodeShares, setNewCodeShares] = useState('');
  const [opDays, setOpDays] = useState<boolean[]>([true, true, true, true, true, true, true]);

  // Set defaults based on targetLegs
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen && targetLegs.length > 0) {
      // Find min/max dates
      const dates = targetLegs.map(l => new Date(l.date).getTime());
      const minDate = new Date(Math.min(...dates));
      const maxDate = new Date(Math.max(...dates));
      
      setFromDate(minDate.toISOString().split('T')[0]);
      setToDate(maxDate.toISOString().split('T')[0]);

      // Set defaults if all targets share the same value
      const uniqueSchedule = new Set(targetLegs.map(l => l.schedule));
      setNewSchedule(uniqueSchedule.size === 1 ? Array.from(uniqueSchedule)[0] : '');

      const uniqueAircraft = new Set(targetLegs.map(l => l.aircraft));
      setNewAircraft(uniqueAircraft.size === 1 ? Array.from(uniqueAircraft)[0] : '');

      const uniqueCodeShares = new Set(targetLegs.map(l => l.codeShares ?? ''));
      setNewCodeShares(uniqueCodeShares.size === 1 ? Array.from(uniqueCodeShares)[0] : '');

      // Determine active days
      const daysActive = [false, false, false, false, false, false, false];
      targetLegs.forEach(l => {
        // JS getDay: 0=Sun, 1=Mon. Our array: 0=Mon, 6=Sun
        const d = new Date(l.date).getDay();
        const idx = d === 0 ? 6 : d - 1;
        daysActive[idx] = true;
      });
      setOpDays(daysActive);
    }
  }, [isOpen, targetLegs]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!isOpen) return null;

  const handleApply = () => {
    const mods: FlightModification[] = [];
    
    const fromTime = new Date(fromDate).getTime();
    const toTime = new Date(toDate).getTime();

    targetLegs.forEach(leg => {
      const legTime = new Date(leg.date).getTime();
      if (legTime >= fromTime && legTime <= toTime) {
        
        // Check if day is unchecked (Delete)
        const d = new Date(leg.date).getDay();
        const dayIdx = d === 0 ? 6 : d - 1;
        
        if (!opDays[dayIdx]) {
          mods.push({ legId: leg.id, action: 'deleted' });
        } else {
          // Check for modifications
          const isSchChanged = newSchedule && newSchedule !== leg.schedule;
          const isAcChanged = newAircraft && newAircraft !== leg.aircraft;
          const isCsChanged = newCodeShares !== (leg.codeShares ?? '');
          
          if (isSchChanged || isAcChanged || isCsChanged) {
             mods.push({
               legId: leg.id,
               action: 'modified',
               ...(isSchChanged ? { schedule: newSchedule } : {}),
               ...(isAcChanged ? { aircraft: newAircraft } : {}),
               ...(isCsChanged ? { codeShares: newCodeShares || null } : {})
             });
          }
        }
      }
    });

    onNext(mods);
  };

  const handleDeleteAll = () => {
    const mods: FlightModification[] = targetLegs.map(l => ({ legId: l.id, action: 'deleted' }));
    onNext(mods);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-xl w-[500px] max-w-[90vw] overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-6 border-b border-surface-variant bg-surface-container-lowest">
          <h2 className="font-h2 text-h2 text-on-surface">Edit Schedule</h2>
          <p className="font-body-sm text-on-surface-variant mt-1">{title}</p>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          
          {/* Period */}
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">PERIOD</h3>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-on-surface-variant mb-1 block">From Date</label>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-on-surface-variant mb-1 block">To Date</label>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm" />
              </div>
            </div>
          </div>

          {/* Details */}
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">NEW DETAILS</h3>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-on-surface-variant mb-1 block">Schedule (STA/STD)</label>
                <input type="text" placeholder="HH:MM" value={newSchedule} onChange={e => setNewSchedule(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-on-surface-variant mb-1 block">Aircraft Type</label>
                <input type="text" placeholder="e.g. 321" value={newAircraft} onChange={e => setNewAircraft(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              </div>
            </div>
            <div className="mt-3">
              <label className="text-xs text-on-surface-variant mb-1 block">CodeShares</label>
              <input type="text" placeholder="e.g. VN123,KE321" value={newCodeShares} onChange={e => setNewCodeShares(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              <p className="text-xs text-on-surface-variant mt-1 opacity-70">Separate multiple codes with commas</p>
            </div>
          </div>

          {/* Operation Days */}
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">OPERATING DAYS</h3>
            <div className="flex gap-2 justify-between">
              {DAYS.map((day, idx) => (
                <label key={day} className="flex flex-col items-center gap-1 cursor-pointer">
                  <span className="text-xs text-on-surface-variant">{day}</span>
                  <input 
                    type="checkbox" 
                    checked={opDays[idx]}
                    onChange={(e) => {
                      const newDays = [...opDays];
                      newDays[idx] = e.target.checked;
                      setOpDays(newDays);
                    }}
                    className="w-5 h-5 rounded text-primary focus:ring-primary"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-error mt-2 italic">* Unchecking will delete the flight on that day.</p>
          </div>

        </div>

        <div className="p-4 border-t border-surface-variant bg-surface-container-low flex justify-between gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-on-surface hover:bg-surface-variant rounded transition-colors">
            Cancel
          </button>
          <div className="flex gap-3">
            <button onClick={handleDeleteAll} className="px-4 py-2 text-sm font-medium text-error border border-error/50 hover:bg-error-container hover:text-on-error-container rounded transition-colors">
              Delete Period
            </button>
            <button onClick={handleApply} className="px-4 py-2 text-sm font-medium bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container rounded transition-colors shadow-sm">
              Review Changes
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
