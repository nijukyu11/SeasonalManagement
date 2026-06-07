'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { CounterAllocationRule, CounterRuleConditions, OperationalSettings } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type RulesTabProps = {
  settings: OperationalSettings;
  ruleName: string;
  setRuleName: Dispatch<SetStateAction<string>>;
  ruleAircraftTypes: string;
  setRuleAircraftTypes: Dispatch<SetStateAction<string>>;
  ruleAirlineCodes: string;
  setRuleAirlineCodes: Dispatch<SetStateAction<string>>;
  ruleAircraftGroups: string[];
  ruleCounterValue: string;
  setRuleCounterValue: Dispatch<SetStateAction<string>>;
  rulePriorityScore: string;
  setRulePriorityScore: Dispatch<SetStateAction<string>>;
  ruleSortOrder: string;
  setRuleSortOrder: Dispatch<SetStateAction<string>>;
  ruleEnabled: boolean;
  setRuleEnabled: Dispatch<SetStateAction<boolean>>;
  addRule: () => void;
  updateRule: (id: string, patch: Partial<CounterAllocationRule>) => void;
  deleteRule: (id: string) => Promise<void>;
  toggleDraftGroup: (groupId: string) => void;
  toggleRuleGroup: (rule: CounterAllocationRule, groupId: string) => void;
  conditionSummary: (rule: CounterAllocationRule, settings: OperationalSettings) => string;
  joinCodes: (values: string[]) => string;
  splitCodes: (value: string) => string[];
  updateConditions: (conditions: CounterRuleConditions, patch: Partial<CounterRuleConditions>) => CounterRuleConditions;
};

export default function RulesTab({
  settings,
  ruleName,
  setRuleName,
  ruleAircraftTypes,
  setRuleAircraftTypes,
  ruleAirlineCodes,
  setRuleAirlineCodes,
  ruleAircraftGroups,
  ruleCounterValue,
  setRuleCounterValue,
  rulePriorityScore,
  setRulePriorityScore,
  ruleSortOrder,
  setRuleSortOrder,
  ruleEnabled,
  setRuleEnabled,
  addRule,
  updateRule,
  deleteRule,
  toggleDraftGroup,
  toggleRuleGroup,
  conditionSummary,
  joinCodes,
  splitCodes,
  updateConditions,
}: RulesTabProps) {
  return (
    <section className="grid gap-5 xl:grid-cols-[420px_1fr]">
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <h2 className="font-title-md text-title-md text-on-surface">Create Counter Rule</h2>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm font-semibold text-on-surface">
            Rule name
            <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Counters
              <input value={ruleCounterValue} onChange={(event) => setRuleCounterValue(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Score
              <input value={rulePriorityScore} onChange={(event) => setRulePriorityScore(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Order
              <input value={ruleSortOrder} onChange={(event) => setRuleSortOrder(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
          </div>
          <label className="block text-sm font-semibold text-on-surface">
            Aircraft types
            <input value={ruleAircraftTypes} onChange={(event) => setRuleAircraftTypes(event.target.value)} placeholder="A321, B787" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Airline codes
            <input value={ruleAirlineCodes} onChange={(event) => setRuleAirlineCodes(event.target.value)} placeholder="VJ, QZ" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <div>
            <div className="mb-2 text-sm font-semibold text-on-surface">A/C Groups</div>
            <div className="flex flex-wrap gap-2">
              {settings.aircraftGroups.length === 0 ? (
                <span className="text-sm text-on-surface-variant">No A/C groups yet</span>
              ) : settings.aircraftGroups.map((group) => (
                <label key={group.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                  <input type="checkbox" checked={ruleAircraftGroups.includes(group.id)} onChange={() => toggleDraftGroup(group.id)} />
                  {group.name}
                </label>
              ))}
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
            <input type="checkbox" checked={ruleEnabled} onChange={(event) => setRuleEnabled(event.target.checked)} />
            Enabled
          </label>
          <button type="button" onClick={addRule} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
            <span className="material-symbols-outlined text-[18px]">rule</span>
            Add Rule
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">Default Counter Allocation</h2>
        </div>
        <div className="hidden grid-cols-[1fr_100px_100px_100px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
          <span>Rule</span>
          <span>Counters</span>
          <span>Score</span>
          <span>Order</span>
          <span>Action</span>
        </div>
        {settings.counterAllocationRules.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No counter rules yet</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {settings.counterAllocationRules.map((rule) => (
              <div key={rule.id} className="space-y-3 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_100px_100px_100px_56px]">
                  <input value={rule.name} onChange={(event) => updateRule(rule.id, { name: event.target.value })} aria-label={`${rule.name || 'Counter rule'} name`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.counterValue)} onChange={(event) => updateRule(rule.id, { counterValue: Number(event.target.value) })} inputMode="numeric" aria-label={`${rule.name || 'Counter rule'} counter value`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.priorityScore)} onChange={(event) => updateRule(rule.id, { priorityScore: Number(event.target.value) })} inputMode="numeric" aria-label={`${rule.name || 'Counter rule'} priority score`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.sortOrder)} onChange={(event) => updateRule(rule.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" aria-label={`${rule.name || 'Counter rule'} sort order`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <DeleteIconButton label={`Delete ${rule.name || 'counter rule'}`} onClick={() => void deleteRule(rule.id)} />
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <label className="block text-xs font-semibold text-on-surface-variant">
                    Aircraft types
                    <input value={joinCodes(rule.conditions.aircraftTypes)} onChange={(event) => updateRule(rule.id, { conditions: updateConditions(rule.conditions, { aircraftTypes: splitCodes(event.target.value) }) })} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none" />
                  </label>
                  <label className="block text-xs font-semibold text-on-surface-variant">
                    Airline codes
                    <input value={joinCodes(rule.conditions.airlineCodes)} onChange={(event) => updateRule(rule.id, { conditions: updateConditions(rule.conditions, { airlineCodes: splitCodes(event.target.value) }) })} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none" />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })} />
                    Enabled
                  </label>
                  {settings.aircraftGroups.map((group) => (
                    <label key={group.id} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                      <input type="checkbox" checked={rule.conditions.aircraftGroups.includes(group.id)} onChange={() => toggleRuleGroup(rule, group.id)} />
                      {group.name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-on-surface-variant">{conditionSummary(rule, settings)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
