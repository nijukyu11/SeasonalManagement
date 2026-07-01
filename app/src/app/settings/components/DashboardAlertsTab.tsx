'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { DashboardAlertSettings, OperationalSettings } from '@/lib/types';

type DashboardAlertsTabProps = {
  settings: OperationalSettings;
  setSettings: Dispatch<SetStateAction<OperationalSettings>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  currentTimestamp: () => number;
};

const fields: Array<{
  key: keyof DashboardAlertSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: string;
}> = [
  {
    key: 'arrivalBucketFlights',
    label: 'ARR bucket threshold',
    hint: 'Chuyến đến mỗi bucket',
    min: 1,
    max: 999,
    step: '1',
  },
  {
    key: 'departureBucketFlights',
    label: 'DEP bucket threshold',
    hint: 'Chuyến đi mỗi bucket',
    min: 1,
    max: 999,
    step: '1',
  },
  {
    key: 'adGapFlights',
    label: 'A-D gap threshold',
    hint: 'Chênh lệch đến/đi',
    min: 1,
    max: 999,
    step: '1',
  },
  {
    key: 'ctgAbsPct',
    label: 'CTG threshold',
    hint: 'Ví dụ 0.2 = 20%',
    min: 0,
    max: 10,
    step: '0.01',
  },
  {
    key: 'paxCoverageMinPct',
    label: 'Pax coverage minimum',
    hint: 'Ví dụ 0.9 = 90%',
    min: 0,
    max: 1,
    step: '0.01',
  },
];

function parseNullableFiniteNumber(rawValue: string): number | null {
  if (rawValue === '') return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function DashboardAlertsTab({
  settings,
  setSettings,
  setStatus,
  currentTimestamp,
}: DashboardAlertsTabProps) {
  const updateThreshold = (key: keyof DashboardAlertSettings, rawValue: string) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      dashboardAlerts: {
        ...current.dashboardAlerts,
        [key]: parseNullableFiniteNumber(rawValue),
      },
      updatedAt: now,
    }));
    setStatus('Unsaved Dashboard Alerts change');
  };

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      {fields.map((field) => (
        <label key={field.key} className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 text-sm font-semibold text-on-surface shadow-sm">
          {field.label}
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={settings.dashboardAlerts[field.key] ?? ''}
            onChange={(event) => updateThreshold(field.key, event.target.value)}
            className="mt-2 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
          <span className="mt-1 block text-xs font-normal text-on-surface-variant">{field.hint}</span>
        </label>
      ))}
    </section>
  );
}
