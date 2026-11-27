'use client';

import React, { useRef, useState } from 'react';
import type { ParsedRow, FlightModification, FlightLeg } from '@/lib/types';
import {
  buildDetailedNewFlightModifications,
  normalizeNewFlightDateSelection,
} from '@/lib/detailedScheduleState';
import type { NewFlightDateSelection } from '@/lib/detailedScheduleState';
import { formatUiError } from '@/lib/uiDisplayText';

const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const CATEGORIES = [
  { value: 'J', label: 'J — Thường lệ' },
  { value: 'C', label: 'C — Thuê chuyến' },
  { value: 'G', label: 'G — Hàng không chung' },
  { value: 'F', label: 'F — Hàng hóa' },
];

type FlightType = 'arrival' | 'departure' | 'turnaround';

interface NewFlightModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'seasonal' | 'detailed';
  seasonStart?: string;
  seasonEnd?: string;
  prefill?: FlightLeg | null; // Pre-fill from a reference flight
  prefillLinked?: FlightLeg | null; // Linked leg for turnaround pre-fill
  prefillDateSelection?: NewFlightDateSelection; // Pre-fill date vector for detailed mode
  onSubmitSeasonal?: (row: Omit<ParsedRow, 'rowIndex'>) => void | Promise<void>;
  onSubmitDetailed?: (mods: FlightModification[]) => void | Promise<void>;
}

export default function NewFlightModal(props: NewFlightModalProps) {
  if (!props.isOpen) return null;
  return <NewFlightModalContent {...props} />;
}

function NewFlightModalContent({
  onClose,
  mode,
  seasonStart,
  seasonEnd,
  prefill,
  prefillLinked,
  prefillDateSelection,
  onSubmitSeasonal,
  onSubmitDetailed,
}: NewFlightModalProps) {
  const selectedDatesText = normalizeNewFlightDateSelection(prefillDateSelection).join(', ');
  const arrLeg = prefill?.type === 'A' ? prefill : (prefillLinked?.type === 'A' ? prefillLinked : null);
  const depLeg = prefill?.type === 'D' ? prefill : (prefillLinked?.type === 'D' ? prefillLinked : null);
  const initialFlightType: FlightType = arrLeg && depLeg ? 'turnaround' : arrLeg ? 'arrival' : depLeg ? 'departure' : 'turnaround';

  // Shared fields
  const [airline, setAirline] = useState(prefill?.airline || '');
  const [flightType, setFlightType] = useState<FlightType>(initialFlightType);
  const [aircraft, setAircraft] = useState(prefill?.aircraft || '');
  const [category, setCategory] = useState(prefill?.category || 'J');

  // Arrival fields
  const [arrFlightNum, setArrFlightNum] = useState(arrLeg?.rawFlightNumber || '');
  const [arrRoute, setArrRoute] = useState(arrLeg?.route || '');
  const [arrTime, setArrTime] = useState(arrLeg?.schedule || '');
  const [arrCodeShares, setArrCodeShares] = useState(arrLeg?.codeShares || '');

  // Departure fields
  const [depFlightNum, setDepFlightNum] = useState(depLeg?.rawFlightNumber || '');
  const [depRoute, setDepRoute] = useState(depLeg?.route || '');
  const [depTime, setDepTime] = useState(depLeg?.schedule || '');
  const [depCodeShares, setDepCodeShares] = useState(depLeg?.codeShares || '');

  // Seasonal-only
  const [effective, setEffective] = useState(seasonStart || '');
  const [discontinue, setDiscontinue] = useState(seasonEnd || '');
  const [opDays, setOpDays] = useState<boolean[]>([true, true, true, true, true, true, true]);

  // Detailed-only
  const [flightDates, setFlightDates] = useState(selectedDatesText);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const showArr = flightType === 'arrival' || flightType === 'turnaround';
  const showDep = flightType === 'departure' || flightType === 'turnaround';

  const canSubmit = () => {
    if (!airline.trim()) return false;
    if (showArr && (!arrFlightNum.trim() || !arrRoute.trim() || !arrTime.trim())) return false;
    if (showDep && (!depFlightNum.trim() || !depRoute.trim() || !depTime.trim())) return false;
    if (mode === 'seasonal' && (!effective || !discontinue)) return false;
    if (mode === 'detailed' && normalizeNewFlightDateSelection(undefined, flightDates).length === 0) return false;
    return true;
  };

  const handleSubmit = () => {
    if (submittingRef.current || !canSubmit()) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    const submit = async () => {
      try {
        if (mode === 'seasonal' && onSubmitSeasonal) {
          const row: Omit<ParsedRow, 'rowIndex'> = {
            effective,
            discontinue,
            airline: airline.trim().toUpperCase(),
            aircraft: aircraft.trim(),
            daysOfWeek: opDays,
            sta: showArr ? arrTime : null,
            arrFlight: showArr ? arrFlightNum.trim() : null,
            arrFlightType: showArr ? 'PAX' : null,
            arrRoute: showArr ? arrRoute.trim().toUpperCase() : null,
            arrFlightCategory: showArr ? category : null,
            arrCodeShares: showArr && arrCodeShares.trim() ? arrCodeShares.trim() : null,
            arrIntDomInd: null,
            std: showDep ? depTime : null,
            depFlight: showDep ? depFlightNum.trim() : null,
            depFlightType: showDep ? 'PAX' : null,
            depRoute: showDep ? depRoute.trim().toUpperCase() : null,
            depFlightCategory: showDep ? category : null,
            depCodeShares: showDep && depCodeShares.trim() ? depCodeShares.trim() : null,
            depIntDomInd: null,
          };
          await onSubmitSeasonal(row);
        } else if (mode === 'detailed' && onSubmitDetailed) {
          const mods = buildDetailedNewFlightModifications({
            dates: normalizeNewFlightDateSelection(undefined, flightDates),
            airline,
            flightType,
            aircraft,
            category,
            arrFlightNum,
            arrRoute,
            arrTime,
            arrCodeShares,
            depFlightNum,
            depRoute,
            depTime,
            depCodeShares,
          });
          await onSubmitDetailed(mods);
        }
        onClose();
      } catch (error) {
        setSubmitError(formatUiError(error));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    };

    void submit();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-xl w-[560px] max-w-[90vw] overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="p-6 border-b border-surface-variant bg-surface-container-lowest">
          <h2 className="font-h2 text-h2 text-on-surface">Thêm chuyến bay</h2>
          <p className="font-body-sm text-on-surface-variant mt-1">
            {mode === 'seasonal' ? 'Tạo lịch bay lặp lại theo tuần' : 'Thêm chuyến bay vào các ngày cụ thể'}
          </p>
        </div>

        {/* Body */}
        <fieldset disabled={submitting} className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">

          {/* Flight Type */}
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">LOẠI CHUYẾN</h3>
            <div className="flex gap-3">
              {(['arrival', 'departure', 'turnaround'] as FlightType[]).map(t => (
                <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="flightType"
                    checked={flightType === t}
                    onChange={() => setFlightType(t)}
                    className="accent-primary"
                  />
                  {t === 'arrival' ? 'Đến' : t === 'departure' ? 'Đi' : 'Cặp chuyến'}
                </label>
              ))}
            </div>
          </div>

          {/* Common Fields */}
          <div>
            <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">THÔNG TIN CHUNG</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Hãng bay</label>
                <input type="text" placeholder="VJ" value={airline} onChange={e => setAirline(e.target.value)} maxLength={3} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular uppercase placeholder:opacity-40" />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Tàu bay</label>
                <input type="text" placeholder="321" value={aircraft} onChange={e => setAircraft(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Loại chuyến</label>
                <select value={category} onChange={e => setCategory(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm">
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Arrival Side */}
          {showArr && (
            <div className="border border-blue-200 bg-blue-50/30 dark:bg-blue-900/10 rounded-lg p-4">
              <h3 className="font-label-caps text-label-caps text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]">flight_land</span>
                CHUYẾN ĐẾN
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Số hiệu</label>
                  <input type="text" placeholder="511" value={arrFlightNum} onChange={e => setArrFlightNum(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
                </div>
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Chặng (từ)</label>
                  <input type="text" placeholder="SGN" value={arrRoute} onChange={e => setArrRoute(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular uppercase placeholder:opacity-40" />
                </div>
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Giờ đến</label>
                  <input type="time" value={arrTime} onChange={e => setArrTime(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular" />
                </div>
              </div>
              <div className="mt-2">
                <label className="text-xs text-on-surface-variant mb-1 block">Liên danh</label>
                <input type="text" placeholder="VN123,KE321" value={arrCodeShares} onChange={e => setArrCodeShares(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              </div>
            </div>
          )}

          {/* Departure Side */}
          {showDep && (
            <div className="border border-emerald-200 bg-emerald-50/30 dark:bg-emerald-900/10 rounded-lg p-4">
              <h3 className="font-label-caps text-label-caps text-emerald-700 dark:text-emerald-300 mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]">flight_takeoff</span>
                CHUYẾN ĐI
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Số hiệu</label>
                  <input type="text" placeholder="512" value={depFlightNum} onChange={e => setDepFlightNum(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
                </div>
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Chặng (đến)</label>
                  <input type="text" placeholder="SGN" value={depRoute} onChange={e => setDepRoute(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular uppercase placeholder:opacity-40" />
                </div>
                <div>
                  <label className="text-xs text-on-surface-variant mb-1 block">Giờ đi</label>
                  <input type="time" value={depTime} onChange={e => setDepTime(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular" />
                </div>
              </div>
              <div className="mt-2">
                <label className="text-xs text-on-surface-variant mb-1 block">Liên danh</label>
                <input type="text" placeholder="VN456,KE654" value={depCodeShares} onChange={e => setDepCodeShares(e.target.value)} className="w-full bg-surface border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40" />
              </div>
            </div>
          )}

          {/* Seasonal: Validity & Days */}
          {mode === 'seasonal' && (
            <div>
              <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">THỜI GIAN HIỆU LỰC</h3>
              <div className="flex gap-4 mb-4">
                <div className="flex-1">
                  <label className="text-xs text-on-surface-variant mb-1 block">Từ ngày</label>
                  <input type="date" value={effective} onChange={e => setEffective(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm" />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-on-surface-variant mb-1 block">Đến ngày</label>
                  <input type="date" value={discontinue} onChange={e => setDiscontinue(e.target.value)} className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm" />
                </div>
              </div>
              <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">NGÀY KHAI THÁC</h3>
              <div className="flex gap-2 justify-between">
                {DAYS.map((day, idx) => (
                  <label key={day} className="flex flex-col items-center gap-1 cursor-pointer">
                    <span className="text-xs text-on-surface-variant">{day}</span>
                    <input
                      type="checkbox"
                      checked={opDays[idx]}
                      onChange={e => {
                        const nd = [...opDays];
                        nd[idx] = e.target.checked;
                        setOpDays(nd);
                      }}
                      className="w-5 h-5 rounded text-primary focus:ring-primary"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Detailed: Date Selection */}
          {mode === 'detailed' && (
            <div>
              <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-2">NGÀY BAY</h3>
              <input
                type="text"
                placeholder="2026-06-01, 2026-06-05, 2026-06-10"
                value={flightDates}
                onChange={e => setFlightDates(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded p-2 text-sm font-data-tabular placeholder:opacity-40"
              />
              <p className="text-xs text-on-surface-variant mt-1 opacity-70">
                Đã chọn {normalizeNewFlightDateSelection(undefined, flightDates).length} ngày. Nhập các ngày cách nhau bằng dấu phẩy, định dạng YYYY-MM-DD.
              </p>
            </div>
          )}

        </fieldset>
        {submitError && <p role="alert" className="px-6 py-2 text-sm text-error">{submitError}</p>}

        {/* Footer */}
        <div className="p-4 border-t border-surface-variant bg-surface-container-low flex justify-between gap-3">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2 text-sm font-medium text-on-surface hover:bg-surface-variant rounded transition-colors disabled:opacity-40">
            Hủy
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !canSubmit()}
            className="px-6 py-2 text-sm font-medium bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container rounded transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            {submitting ? 'Đang lưu…' : mode === 'seasonal' ? 'Tạo lịch bay' : 'Thêm chuyến bay'}
          </button>
        </div>

      </div>
    </div>
  );
}
