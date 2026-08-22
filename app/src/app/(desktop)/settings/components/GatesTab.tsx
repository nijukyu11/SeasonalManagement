'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { GateGroup, GateResource, StandGateMapping } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type GatesTabProps = {
  gateResources: GateResource[];
  gateGroups: GateGroup[];
  standGateMappings: StandGateMapping[];
  standMappingStand: string;
  setStandMappingStand: Dispatch<SetStateAction<string>>;
  standMappingGate: string;
  setStandMappingGate: Dispatch<SetStateAction<string>>;
  addStandGateMapping: () => void;
  updateStandGateMapping: (id: string, patch: Partial<StandGateMapping>) => void;
  deleteStandGateMapping: (id: string) => void;
  gateLabel: string;
  setGateLabel: Dispatch<SetStateAction<string>>;
  addGateResource: () => void;
  updateGateResource: (id: string, patch: Partial<GateResource>) => void;
  deleteGateResource: (id: string) => Promise<void>;
  gateGroupName: string;
  setGateGroupName: Dispatch<SetStateAction<string>>;
  gateGroupGateIds: string[];
  toggleDraftGateGroupGate: (gateId: string) => void;
  addGateGroup: () => void;
  updateGateGroup: (id: string, patch: Partial<GateGroup>) => void;
  toggleGateGroupGate: (groupId: string, gateId: string) => void;
};

export default function GatesTab({
  gateResources,
  gateGroups,
  standGateMappings,
  standMappingStand,
  setStandMappingStand,
  standMappingGate,
  setStandMappingGate,
  addStandGateMapping,
  updateStandGateMapping,
  deleteStandGateMapping,
  gateLabel,
  setGateLabel,
  addGateResource,
  updateGateResource,
  deleteGateResource,
  gateGroupName,
  setGateGroupName,
  gateGroupGateIds,
  toggleDraftGateGroupGate,
  addGateGroup,
  updateGateGroup,
  toggleGateGroupGate,
}: GatesTabProps) {
  return (
    <section className="space-y-5">
      <div data-testid="gate-inventory-groups-stack" className="space-y-5">
        <div className="w-full overflow-hidden rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-title-md text-title-md text-on-surface">Gate Inventory</h2>
                <p className="mt-1 text-sm text-on-surface-variant">{gateResources.length} gates configured</p>
              </div>
              <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
                <label className="min-w-[120px] flex-1 text-sm font-semibold text-on-surface sm:flex-none">
                  Gate label
                  <input
                    value={gateLabel}
                    onChange={(event) => setGateLabel(event.target.value)}
                    inputMode="numeric"
                    placeholder="11"
                    className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                  />
                </label>
                <button type="button" onClick={addGateResource} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
                  <span className="material-symbols-outlined text-[18px]">add</span>
                  Add Gate
                </button>
              </div>
            </div>
          </div>
          <div aria-label="Gate inventory table" role="table">
            <div role="row" className="hidden border-b border-surface-variant bg-surface-container-low px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant sm:grid sm:grid-cols-[minmax(80px,1fr)_90px_120px_120px] sm:items-center sm:gap-3">
              <span role="columnheader">Gate</span>
              <span role="columnheader">Sort</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="text-right">Action</span>
            </div>
            {gateResources.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-on-surface-variant">No gates configured</div>
            ) : (
              <div className="divide-y divide-surface-variant">
                {gateResources.map((gate) => (
                  <div key={gate.id} role="row" className="grid gap-3 p-4 sm:grid-cols-[minmax(80px,1fr)_90px_120px_120px] sm:items-center">
                    <label role="cell" className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant sm:block sm:tracking-normal">
                      <span className="sm:hidden">Gate</span>
                      <input value={gate.label} onChange={(event) => updateGateResource(gate.id, { label: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-semibold text-on-surface focus:border-primary focus:outline-none" />
                    </label>
                    <label role="cell" className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant sm:block sm:tracking-normal">
                      <span className="sm:hidden">Sort</span>
                      <input value={String(gate.sortOrder)} onChange={(event) => updateGateResource(gate.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none" />
                    </label>
                    <div role="cell">
                      <label className={`inline-flex w-full items-center justify-between gap-3 rounded-full border px-3 py-2 text-sm font-semibold transition-colors ${gate.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-outline-variant bg-surface-container-low text-on-surface-variant'}`}>
                        <input type="checkbox" checked={gate.enabled} onChange={(event) => updateGateResource(gate.id, { enabled: event.target.checked })} className="sr-only" />
                        <span>{gate.enabled ? 'Enabled' : 'Disabled'}</span>
                        <span className={`relative h-5 w-9 rounded-full transition-colors ${gate.enabled ? 'bg-emerald-500' : 'bg-outline-variant'}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${gate.enabled ? 'left-4' : 'left-0.5'}`} />
                        </span>
                      </label>
                    </div>
                    <div role="cell" className="sm:text-right">
                      <DeleteIconButton label={`Delete Gate ${gate.label}`} onClick={() => void deleteGateResource(gate.id)} className="sm:ml-auto" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="w-full rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Gate Groups</h2>
          </div>
          <div className="border-b border-surface-variant p-4">
            <div className="grid gap-3">
              <label className="block text-sm font-semibold text-on-surface">
                Group name
                <input
                  value={gateGroupName}
                  onChange={(event) => setGateGroupName(event.target.value)}
                  placeholder="Gate Remote"
                  className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
              </label>
              <div>
                <div className="mb-2 text-sm font-semibold text-on-surface">Gates</div>
                <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-outline-variant p-2">
                  {gateResources.length === 0 ? (
                    <span className="text-sm text-on-surface-variant">No gates available</span>
                  ) : gateResources.map((gate) => (
                    <label key={gate.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={gateGroupGateIds.includes(gate.id)}
                        onChange={() => toggleDraftGateGroupGate(gate.id)}
                      />
                      Gate {gate.label}
                    </label>
                  ))}
                </div>
              </div>
              <button type="button" onClick={addGateGroup} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
                <span className="material-symbols-outlined text-[18px]">add</span>
                Add Group
              </button>
            </div>
          </div>
          <div className="hidden grid-cols-[1fr_110px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Group</span>
            <span>Order</span>
          </div>
          <div className="divide-y divide-surface-variant">
            {gateGroups.map((group) => (
              <div key={group.id} className="space-y-3 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_110px]">
                  <input value={group.name} onChange={(event) => updateGateGroup(group.id, { name: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(group.sortOrder)} onChange={(event) => updateGateGroup(group.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" aria-label={`${group.name} order`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                </div>
                <div className="flex flex-wrap gap-2 rounded-lg border border-outline-variant p-2">
                  {gateResources.map((gate) => (
                    <label key={gate.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                      <input type="checkbox" checked={group.gateIds.includes(gate.id)} onChange={() => toggleGateGroupGate(group.id, gate.id)} />
                      Gate {gate.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Add Stand Mapping</h2>
          <div className="mt-4 grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-semibold text-on-surface">
                Stand
                <input value={standMappingStand} onChange={(event) => setStandMappingStand(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
              <label className="block text-sm font-semibold text-on-surface">
                Gate
                <input value={standMappingGate} onChange={(event) => setStandMappingGate(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
            </div>
            <button type="button" onClick={addStandGateMapping} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">add</span>
              Add Stand Mapping
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
          <div className="border-b border-surface-variant px-4 py-3">
            <h2 className="font-title-md text-title-md text-on-surface">Stand Mapping Table</h2>
          </div>
          <div className="hidden grid-cols-[110px_110px_110px_120px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
            <span>Stand</span>
            <span>Gate</span>
            <span>Order</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          <div className="divide-y divide-surface-variant">
            {standGateMappings.map((mapping) => (
              <div key={mapping.id} className="grid gap-3 p-4 lg:grid-cols-[110px_110px_110px_120px_56px]">
                <input value={String(mapping.stand)} onChange={(event) => updateStandGateMapping(mapping.id, { stand: Number(event.target.value) })} inputMode="numeric" aria-label={`${mapping.id} stand`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                <input value={String(mapping.gate)} onChange={(event) => updateStandGateMapping(mapping.id, { gate: Number(event.target.value) })} inputMode="numeric" aria-label={`${mapping.id} gate`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                <input value={String(mapping.sortOrder)} onChange={(event) => updateStandGateMapping(mapping.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" aria-label={`${mapping.id} order`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                  <input type="checkbox" checked={mapping.enabled} onChange={(event) => updateStandGateMapping(mapping.id, { enabled: event.target.checked })} />
                  Enabled
                </label>
                <DeleteIconButton label={`Delete stand mapping ${mapping.stand} to ${mapping.gate}`} onClick={() => deleteStandGateMapping(mapping.id)} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
