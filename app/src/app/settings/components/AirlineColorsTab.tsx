'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { AirlineColorSetting, OperationalSettings } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type AirlineColorsTabProps = {
  settings: OperationalSettings;
  airlineColorCode: string;
  setAirlineColorCode: Dispatch<SetStateAction<string>>;
  airlineColorValue: string;
  setAirlineColorValue: Dispatch<SetStateAction<string>>;
  normalizeAirlineColorValue: (value: string) => string;
  addAirlineColor: () => void;
  updateAirlineColor: (airlineCode: string, patch: Partial<AirlineColorSetting>) => void;
  deleteAirlineColor: (airlineCode: string) => void;
};

export default function AirlineColorsTab({
  settings,
  airlineColorCode,
  setAirlineColorCode,
  airlineColorValue,
  setAirlineColorValue,
  normalizeAirlineColorValue,
  addAirlineColor,
  updateAirlineColor,
  deleteAirlineColor,
}: AirlineColorsTabProps) {
  return (
    <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Add Airline Color</h2>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm font-semibold text-on-surface">
            Airline code
            <input value={airlineColorCode} onChange={(event) => setAirlineColorCode(event.target.value.toUpperCase())} placeholder="ZZ" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Color
            <div className="mt-1 flex gap-2">
              <input type="color" value={airlineColorValue} onChange={(event) => setAirlineColorValue(event.target.value.toUpperCase())} className="h-10 w-12 rounded border border-outline-variant bg-surface" />
              <input value={airlineColorValue} onChange={(event) => setAirlineColorValue(normalizeAirlineColorValue(event.target.value))} className="min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface px-3 py-2 font-data-tabular text-sm focus:border-primary focus:outline-none" />
            </div>
          </label>
          <button type="button" onClick={addAirlineColor} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
            <span className="material-symbols-outlined text-[18px]">palette</span>
            Add Color
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">Airline Colors</h2>
        </div>
        <div className="hidden grid-cols-[120px_64px_160px_1fr_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
          <span>Airline</span>
          <span>Swatch</span>
          <span>Hex</span>
          <span>Preview</span>
          <span>Action</span>
        </div>
        {settings.airlineColors.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No airline colors configured</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {settings.airlineColors.map((item) => (
              <div key={item.airlineCode} className="grid items-center gap-3 p-4 lg:grid-cols-[120px_64px_160px_1fr_56px]">
                <input value={item.airlineCode} onChange={(event) => updateAirlineColor(item.airlineCode, { airlineCode: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 font-data-tabular text-sm font-semibold focus:border-primary focus:outline-none" />
                <input type="color" value={item.color} onChange={(event) => updateAirlineColor(item.airlineCode, { color: event.target.value })} className="h-10 w-14 rounded border border-outline-variant bg-surface" />
                <input value={item.color} onChange={(event) => updateAirlineColor(item.airlineCode, { color: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 font-data-tabular text-sm focus:border-primary focus:outline-none" />
                <div className="flex min-w-0 items-center gap-3">
                  <span className="h-8 w-16 rounded border border-outline-variant" style={{ backgroundColor: item.color }} />
                  <span className="truncate text-sm font-semibold text-on-surface">{item.airlineCode}</span>
                </div>
                <DeleteIconButton label={`Delete ${item.airlineCode} color`} onClick={() => deleteAirlineColor(item.airlineCode)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
