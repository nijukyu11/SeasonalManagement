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
        <h2 className="font-title-md text-title-md text-on-surface">Tạo quy tắc quầy</h2>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm font-semibold text-on-surface">
            Tên quy tắc
            <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Số quầy
              <input value={ruleCounterValue} onChange={(event) => setRuleCounterValue(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Điểm ưu tiên
              <input value={rulePriorityScore} onChange={(event) => setRulePriorityScore(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Thứ tự
              <input value={ruleSortOrder} onChange={(event) => setRuleSortOrder(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
          </div>
          <label className="block text-sm font-semibold text-on-surface">
            Loại tàu bay
            <input value={ruleAircraftTypes} onChange={(event) => setRuleAircraftTypes(event.target.value)} placeholder="A321, B787" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Mã hãng bay
            <input value={ruleAirlineCodes} onChange={(event) => setRuleAirlineCodes(event.target.value)} placeholder="VJ, QZ" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
          <div>
            <div className="mb-2 text-sm font-semibold text-on-surface">Nhóm tàu bay</div>
            <div className="flex flex-wrap gap-2">
              {settings.aircraftGroups.length === 0 ? (
                <span className="text-sm text-on-surface-variant">Chưa có nhóm tàu bay nào</span>
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
            Đang bật
          </label>
          <button type="button" onClick={addRule} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
            <span className="material-symbols-outlined text-[18px]">rule</span>
            Thêm quy tắc
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="border-b border-surface-variant px-4 py-3">
          <h2 className="font-title-md text-title-md text-on-surface">Phân bổ quầy mặc định</h2>
        </div>
        <div className="hidden grid-cols-[1fr_100px_100px_100px_56px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant lg:grid">
          <span>Quy tắc</span>
          <span>Số quầy</span>
          <span>Điểm</span>
          <span>Thứ tự</span>
          <span>Thao tác</span>
        </div>
        {settings.counterAllocationRules.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">Chưa có quy tắc quầy nào</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {settings.counterAllocationRules.map((rule) => (
              <div key={rule.id} className="space-y-3 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_100px_100px_100px_56px]">
                  <input value={rule.name} onChange={(event) => updateRule(rule.id, { name: event.target.value })} aria-label={`Tên ${rule.name || 'quy tắc quầy'}`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.counterValue)} onChange={(event) => updateRule(rule.id, { counterValue: Number(event.target.value) })} inputMode="numeric" aria-label={`Số quầy của ${rule.name || 'quy tắc quầy'}`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.priorityScore)} onChange={(event) => updateRule(rule.id, { priorityScore: Number(event.target.value) })} inputMode="numeric" aria-label={`Điểm ưu tiên của ${rule.name || 'quy tắc quầy'}`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <input value={String(rule.sortOrder)} onChange={(event) => updateRule(rule.id, { sortOrder: Number(event.target.value) })} inputMode="numeric" aria-label={`Thứ tự của ${rule.name || 'quy tắc quầy'}`} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <DeleteIconButton label={`Xóa ${rule.name || 'quy tắc quầy'}`} onClick={() => void deleteRule(rule.id)} />
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <label className="block text-xs font-semibold text-on-surface-variant">
                    Loại tàu bay
                    <input value={joinCodes(rule.conditions.aircraftTypes)} onChange={(event) => updateRule(rule.id, { conditions: updateConditions(rule.conditions, { aircraftTypes: splitCodes(event.target.value) }) })} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none" />
                  </label>
                  <label className="block text-xs font-semibold text-on-surface-variant">
                    Mã hãng bay
                    <input value={joinCodes(rule.conditions.airlineCodes)} onChange={(event) => updateRule(rule.id, { conditions: updateConditions(rule.conditions, { airlineCodes: splitCodes(event.target.value) }) })} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none" />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })} />
                    Đang bật
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
