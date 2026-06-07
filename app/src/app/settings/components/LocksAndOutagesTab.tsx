'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { CheckInCounterLock, CheckInCounterResource, GateLock, GateResource, OperationalSettings } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type LocksAndOutagesTabProps = {
  settings: OperationalSettings;
  checkInCounters: CheckInCounterResource[];
  gateResources: GateResource[];
  gateLocks: GateLock[];
  lockName: string;
  setLockName: Dispatch<SetStateAction<string>>;
  lockCounterIds: string[];
  lockStart: string;
  setLockStart: Dispatch<SetStateAction<string>>;
  lockEnd: string;
  setLockEnd: Dispatch<SetStateAction<string>>;
  lockReason: string;
  setLockReason: Dispatch<SetStateAction<string>>;
  lockEnabled: boolean;
  setLockEnabled: Dispatch<SetStateAction<boolean>>;
  gateLockName: string;
  setGateLockName: Dispatch<SetStateAction<string>>;
  gateLockGateIds: string[];
  gateLockStart: string;
  setGateLockStart: Dispatch<SetStateAction<string>>;
  gateLockEnd: string;
  setGateLockEnd: Dispatch<SetStateAction<string>>;
  gateLockReason: string;
  setGateLockReason: Dispatch<SetStateAction<string>>;
  gateLockEnabled: boolean;
  setGateLockEnabled: Dispatch<SetStateAction<boolean>>;
  toggleDraftLockCounter: (counterId: string) => void;
  addCheckInCounterLock: () => void;
  updateCheckInCounterLock: (id: string, patch: Partial<CheckInCounterLock>) => void;
  toggleCheckInCounterLockCounter: (lock: CheckInCounterLock, counterId: string) => void;
  deleteCheckInCounterLock: (id: string) => Promise<void>;
  toggleDraftGateLockGate: (gateId: string) => void;
  addGateLock: () => void;
  updateGateLock: (id: string, patch: Partial<GateLock>) => void;
  toggleGateLockGate: (lock: GateLock, gateId: string) => void;
  deleteGateLock: (id: string) => Promise<void>;
};

export default function LocksAndOutagesTab({
  settings,
  checkInCounters,
  gateResources,
  gateLocks,
  lockName,
  setLockName,
  lockCounterIds,
  lockStart,
  setLockStart,
  lockEnd,
  setLockEnd,
  lockReason,
  setLockReason,
  lockEnabled,
  setLockEnabled,
  gateLockName,
  setGateLockName,
  gateLockGateIds,
  gateLockStart,
  setGateLockStart,
  gateLockEnd,
  setGateLockEnd,
  gateLockReason,
  setGateLockReason,
  gateLockEnabled,
  setGateLockEnabled,
  toggleDraftLockCounter,
  addCheckInCounterLock,
  updateCheckInCounterLock,
  toggleCheckInCounterLockCounter,
  deleteCheckInCounterLock,
  toggleDraftGateLockGate,
  addGateLock,
  updateGateLock,
  toggleGateLockGate,
  deleteGateLock,
}: LocksAndOutagesTabProps) {
  return (
    <section className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Create Counter Lock</h2>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Lock name
              <input value={lockName} onChange={(event) => setLockName(event.target.value)} placeholder="C2 Maintenance" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="block text-sm font-semibold text-on-surface">
                Start
                <input type="datetime-local" value={lockStart} onChange={(event) => setLockStart(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
              <label className="block text-sm font-semibold text-on-surface">
                End
                <input type="datetime-local" value={lockEnd} onChange={(event) => setLockEnd(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
            </div>
            <label className="block text-sm font-semibold text-on-surface">
              Reason
              <input value={lockReason} onChange={(event) => setLockReason(event.target.value)} placeholder="Maintenance" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <div>
              <div className="mb-2 text-sm font-semibold text-on-surface">Counters</div>
              <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                {checkInCounters.length === 0 ? (
                  <span className="text-sm text-on-surface-variant">No counters available</span>
                ) : checkInCounters.map((counter) => (
                  <label key={counter.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input type="checkbox" checked={lockCounterIds.includes(counter.id)} onChange={() => toggleDraftLockCounter(counter.id)} />
                    {counter.label}
                  </label>
                ))}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
              <input type="checkbox" checked={lockEnabled} onChange={(event) => setLockEnabled(event.target.checked)} />
              Enabled
            </label>
            <button type="button" onClick={addCheckInCounterLock} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">lock</span>
              Add Counter Lock
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Counter Locks</h2>
          </div>
          <div className="hidden grid-cols-[1fr_180px_180px_1fr_120px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Name</span>
            <span>Start</span>
            <span>End</span>
            <span>Reason</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {settings.checkInCounterLocks.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No counter locks yet</div>
          ) : (
            <div className="divide-y divide-surface-variant">
              {settings.checkInCounterLocks.map((lock) => (
                <div key={lock.id} className="space-y-3 p-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_1fr_120px_56px]">
                    <input value={lock.name} onChange={(event) => updateCheckInCounterLock(lock.id, { name: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input type="datetime-local" value={lock.start} onChange={(event) => updateCheckInCounterLock(lock.id, { start: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input type="datetime-local" value={lock.end} onChange={(event) => updateCheckInCounterLock(lock.id, { end: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input value={lock.reason ?? ''} onChange={(event) => updateCheckInCounterLock(lock.id, { reason: event.target.value.trim() || null })} placeholder="Reason" className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                      <input type="checkbox" checked={lock.enabled} onChange={(event) => updateCheckInCounterLock(lock.id, { enabled: event.target.checked })} />
                      Enabled
                    </label>
                    <DeleteIconButton label={`Delete Counter Lock ${lock.name}`} onClick={() => void deleteCheckInCounterLock(lock.id)} />
                  </div>
                  <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                    {checkInCounters.length === 0 ? (
                      <span className="text-sm text-on-surface-variant">No counters available</span>
                    ) : checkInCounters.map((counter) => (
                      <label key={counter.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                        <input type="checkbox" checked={lock.counterIds.includes(counter.id)} onChange={() => toggleCheckInCounterLockCounter(lock, counter.id)} />
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

      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Create Gate Lock</h2>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Lock name
              <input value={gateLockName} onChange={(event) => setGateLockName(event.target.value)} placeholder="Gate maintenance" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="block text-sm font-semibold text-on-surface">
                Start
                <input type="datetime-local" value={gateLockStart} onChange={(event) => setGateLockStart(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
              <label className="block text-sm font-semibold text-on-surface">
                End
                <input type="datetime-local" value={gateLockEnd} onChange={(event) => setGateLockEnd(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
            </div>
            <label className="block text-sm font-semibold text-on-surface">
              Reason
              <input value={gateLockReason} onChange={(event) => setGateLockReason(event.target.value)} placeholder="Maintenance" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <div>
              <div className="mb-2 text-sm font-semibold text-on-surface">Gates</div>
              <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                {gateResources.length === 0 ? (
                  <span className="text-sm text-on-surface-variant">No gates available</span>
                ) : gateResources.map((gate) => (
                  <label key={gate.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input type="checkbox" checked={gateLockGateIds.includes(gate.id)} onChange={() => toggleDraftGateLockGate(gate.id)} />
                    Gate {gate.label}
                  </label>
                ))}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
              <input type="checkbox" checked={gateLockEnabled} onChange={(event) => setGateLockEnabled(event.target.checked)} />
              Enabled
            </label>
            <button type="button" onClick={addGateLock} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">lock</span>
              Add Gate Lock
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Gate Locks</h2>
          </div>
          <div className="hidden grid-cols-[1fr_180px_180px_1fr_120px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Name</span>
            <span>Start</span>
            <span>End</span>
            <span>Reason</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {gateLocks.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No gate locks yet</div>
          ) : (
            <div className="divide-y divide-surface-variant">
              {gateLocks.map((lock) => (
                <div key={lock.id} className="space-y-3 p-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_1fr_120px_56px]">
                    <input value={lock.name} onChange={(event) => updateGateLock(lock.id, { name: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input type="datetime-local" value={lock.start} onChange={(event) => updateGateLock(lock.id, { start: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input type="datetime-local" value={lock.end} onChange={(event) => updateGateLock(lock.id, { end: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <input value={lock.reason ?? ''} onChange={(event) => updateGateLock(lock.id, { reason: event.target.value.trim() || null })} placeholder="Reason" className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                    <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                      <input type="checkbox" checked={lock.enabled} onChange={(event) => updateGateLock(lock.id, { enabled: event.target.checked })} />
                      Enabled
                    </label>
                    <DeleteIconButton label={`Delete Gate Lock ${lock.name}`} onClick={() => void deleteGateLock(lock.id)} />
                  </div>
                  <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                    {gateResources.length === 0 ? (
                      <span className="text-sm text-on-surface-variant">No gates available</span>
                    ) : gateResources.map((gate) => (
                      <label key={gate.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                        <input type="checkbox" checked={lock.gateIds.includes(gate.id)} onChange={() => toggleGateLockGate(lock, gate.id)} />
                        Gate {gate.label}
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
