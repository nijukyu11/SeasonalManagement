'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { CheckInCounterGroup, CheckInCounterResource, OperationalSettings } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type CheckInCountersTabProps = {
  settings: OperationalSettings;
  checkInCounters: CheckInCounterResource[];
  counterInventoryInput: string;
  setCounterInventoryInput: Dispatch<SetStateAction<string>>;
  counterLabelDrafts: Record<string, string>;
  setCounterLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  counterGroupName: string;
  setCounterGroupName: Dispatch<SetStateAction<string>>;
  counterGroupBhs: string;
  setCounterGroupBhs: Dispatch<SetStateAction<string>>;
  counterGroupCounterIds: string[];
  addCheckInCounters: () => void;
  updateCheckInCounter: (id: string, patch: Partial<CheckInCounterResource>) => void;
  confirmCheckInCounterLabelChange: (counter: CheckInCounterResource, nextLabel: string) => Promise<void>;
  deleteCheckInCounter: (id: string) => Promise<void>;
  toggleDraftCounterGroupCounter: (counterId: string) => void;
  addCheckInCounterGroup: () => void;
  updateCheckInCounterGroup: (id: string, patch: Partial<CheckInCounterGroup>) => void;
  toggleCheckInCounterGroupCounter: (groupId: string, counterId: string) => void;
  deleteCheckInCounterGroup: (id: string) => Promise<void>;
};

export default function CheckInCountersTab({
  settings,
  checkInCounters,
  counterInventoryInput,
  setCounterInventoryInput,
  counterLabelDrafts,
  setCounterLabelDrafts,
  counterGroupName,
  setCounterGroupName,
  counterGroupBhs,
  setCounterGroupBhs,
  counterGroupCounterIds,
  addCheckInCounters,
  updateCheckInCounter,
  confirmCheckInCounterLabelChange,
  deleteCheckInCounter,
  toggleDraftCounterGroupCounter,
  addCheckInCounterGroup,
  updateCheckInCounterGroup,
  toggleCheckInCounterGroupCounter,
  deleteCheckInCounterGroup,
}: CheckInCountersTabProps) {
  return (
    <section className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Counter Inventory</h2>
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-semibold text-on-surface">
              Add counters
              <input
                value={counterInventoryInput}
                onChange={(event) => setCounterInventoryInput(event.target.value)}
                placeholder="1-54, M1-M7, Transit"
                className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={addCheckInCounters}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Add Counters
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Check-in Counters</h2>
          </div>
          <div className="hidden grid-cols-[1fr_110px_120px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Counter</span>
            <span>Order</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {checkInCounters.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No check-in counters yet</div>
          ) : (
            <div className="divide-y divide-surface-variant">
              {checkInCounters.map((counter) => (
                <div key={counter.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_110px_120px_56px]">
                  <input
                    value={counterLabelDrafts[counter.id] ?? counter.label}
                    onChange={(event) => setCounterLabelDrafts((current) => ({ ...current, [counter.id]: event.target.value }))}
                    onBlur={(event) => void confirmCheckInCounterLabelChange(counter, event.target.value)}
                    aria-label={`${counter.label} label`}
                    className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                  />
                  <input
                    value={String(counter.sortOrder)}
                    onChange={(event) => updateCheckInCounter(counter.id, { sortOrder: Number(event.target.value) })}
                    inputMode="numeric"
                    aria-label={`${counter.label} order`}
                    className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                  />
                  <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={counter.enabled}
                      onChange={(event) => updateCheckInCounter(counter.id, { enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <DeleteIconButton label={`Delete Counter ${counter.label}`} onClick={() => void deleteCheckInCounter(counter.id)} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Create Counter Group / BHS</h2>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Group name
              <input
                value={counterGroupName}
                onChange={(event) => setCounterGroupName(event.target.value)}
                placeholder="Island A"
                className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              BHS
              <input
                value={counterGroupBhs}
                onChange={(event) => setCounterGroupBhs(event.target.value)}
                placeholder="BHS-A"
                className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </label>
            <div>
              <div className="mb-2 text-sm font-semibold text-on-surface">Counters</div>
              <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                {checkInCounters.length === 0 ? (
                  <span className="text-sm text-on-surface-variant">No counters available</span>
                ) : checkInCounters.map((counter) => (
                  <label key={counter.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={counterGroupCounterIds.includes(counter.id)}
                      onChange={() => toggleDraftCounterGroupCounter(counter.id)}
                    />
                    {counter.label}
                  </label>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={addCheckInCounterGroup}
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Add Counter Group
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Counter Groups / BHS</h2>
          </div>
          <div className="hidden grid-cols-[1fr_160px_110px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Group</span>
            <span>BHS</span>
            <span>Order</span>
            <span>Action</span>
          </div>
          {settings.checkInCounterGroups.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No counter groups yet</div>
          ) : (
            <div className="divide-y divide-surface-variant">
              {settings.checkInCounterGroups.map((group) => (
                <div key={group.id} className="space-y-3 p-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_160px_110px_56px]">
                    <input
                      value={group.name}
                      onChange={(event) => updateCheckInCounterGroup(group.id, { name: event.target.value })}
                      aria-label={`${group.name || 'Counter group'} name`}
                      className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                    <input
                      value={group.bhs}
                      onChange={(event) => updateCheckInCounterGroup(group.id, { bhs: event.target.value })}
                      aria-label={`${group.name} BHS`}
                      className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                    <input
                      value={String(group.sortOrder)}
                      onChange={(event) => updateCheckInCounterGroup(group.id, { sortOrder: Number(event.target.value) })}
                      inputMode="numeric"
                      aria-label={`${group.name} order`}
                      className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                    <DeleteIconButton label={`Delete ${group.name || 'counter group'}`} onClick={() => void deleteCheckInCounterGroup(group.id)} />
                  </div>
                  <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                    {checkInCounters.length === 0 ? (
                      <span className="text-sm text-on-surface-variant">No counters available</span>
                    ) : checkInCounters.map((counter) => (
                      <label key={counter.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={group.counterIds.includes(counter.id)}
                          onChange={() => toggleCheckInCounterGroupCounter(group.id, counter.id)}
                        />
                        {counter.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
