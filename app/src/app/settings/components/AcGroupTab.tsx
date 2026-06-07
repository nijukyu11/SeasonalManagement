'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { OperationalSettings } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type AcGroupTabProps = {
  settings: OperationalSettings;
  groupName: string;
  setGroupName: Dispatch<SetStateAction<string>>;
  groupAircraftTypes: string;
  setGroupAircraftTypes: Dispatch<SetStateAction<string>>;
  addGroup: () => void;
  updateGroup: (id: string, patch: { name?: string; aircraftTypes?: string[] }) => void;
  deleteGroup: (id: string) => Promise<void>;
  joinCodes: (values: string[]) => string;
  splitCodes: (value: string) => string[];
};

export default function AcGroupTab({
  settings,
  groupName,
  setGroupName,
  groupAircraftTypes,
  setGroupAircraftTypes,
  addGroup,
  updateGroup,
  deleteGroup,
  joinCodes,
  splitCodes,
}: AcGroupTabProps) {
  return (
    <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Create A/C Group</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-semibold text-on-surface">
            Group name
            <input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="Big"
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Aircraft types
            <input
              value={groupAircraftTypes}
              onChange={(event) => setGroupAircraftTypes(event.target.value)}
              placeholder="A321, B787, 321"
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Add Group
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">A/C Groups</h2>
        </div>
        <div className="hidden grid-cols-[220px_1fr_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
          <span>Group</span>
          <span>Aircraft types</span>
          <span>Action</span>
        </div>
        {settings.aircraftGroups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No A/C groups yet</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {settings.aircraftGroups.map((group) => (
              <div key={group.id} className="grid gap-3 p-4 lg:grid-cols-[220px_1fr_56px]">
                <input
                  value={group.name}
                  onChange={(event) => updateGroup(group.id, { name: event.target.value })}
                  aria-label={`${group.name || 'A/C group'} name`}
                  className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
                <input
                  value={joinCodes(group.aircraftTypes)}
                  onChange={(event) => updateGroup(group.id, { aircraftTypes: splitCodes(event.target.value) })}
                  aria-label={`${group.name || 'A/C group'} aircraft types`}
                  className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                />
                <DeleteIconButton label={`Delete ${group.name || 'A/C group'}`} onClick={() => void deleteGroup(group.id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
