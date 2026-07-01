'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { syncDashboardAiProviderKey } from '@/lib/dashboardAiAdmin';
import { getCurrentOperatorAccess } from '@/lib/operatorUserManagement';
import {
  batchWriteFlightRecords,
  clearSeasonBaseline,
  createSeason,
  findSeasonByCode,
  getOperationalSettings,
  getSeasonEventHighWater,
  getSeasons,
  saveOperationalSettings,
  updateSeason,
  verifySeasonImportCounts,
} from '@/lib/remoteStore';
import { parseSeasonalSchedule } from '@/lib/parser';
import {
  assertNoDuplicateFlightNumbers,
  flattenRowsToFlightRecords,
  flightRecordsToLegs,
  mergeDuplicateImportPeriods,
  mergeDuplicateImportRecords,
} from '@/lib/atomicSchedule';
import { buildCanonicalSeasonalRows } from '@/lib/canonicalSeasonalRows';
import { parseCheckInCounterInventoryInput } from '@/lib/checkInCounterSettings';
import { mergeRouteCountryMappings, normalizeRouteCode, parseRouteCountryRows } from '@/lib/routeCountry';
import {
  deleteCheckInCounterFromSettings,
  deleteGateFromSettings,
  renameCheckInCounterLabelInSettings,
  resolveSettingsAfterSave,
  toggleCheckInCounterGroupMembership,
  toggleCheckInCounterLockMembership,
  toggleGateGroupMembership,
  toggleGateLockMembership,
} from '@/lib/settingsPageActions';
import { DEFAULT_DEEPSEEK_BASE_URL, hydrateOperationalSettings, removeAircraftGroupFromSettings, validateOperationalSettings } from '@/lib/settingsRules';
import { appendAuditLogEntry, buildSettingsAuditDeltas } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { buildSeasonNameFromFileName } from '@/lib/importSeasonRules';
import {
  getCachedSeasons,
  publishSeasonWorkspaceChanged,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import {
  checkNativeSeasonIntegrity,
  importNativeSeasonSnapshot,
  queryNativeSyncSummary,
} from '@/lib/nativeSeasonRepository';
import type {
  AiAnalysisModelSetting,
  AiAnalysisProvider,
  AirlineColorSetting,
  CheckInCounterGroup,
  CheckInCounterLock,
  CheckInCounterResource,
  CounterAllocationRule,
  CounterRuleConditions,
  GateGroup,
  GateLock,
  GateResource,
  OperationalSettings,
  RouteCountryMapping,
  Season,
  StandGateMapping,
} from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';
import { useCachedRouteSearchParams } from '../components/RouteCacheContext';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSessionState } from '../hooks/useSessionState';
import AcGroupTab from './components/AcGroupTab';
import RulesTab from './components/RulesTab';
import CheckInCountersTab from './components/CheckInCountersTab';
import GatesTab from './components/GatesTab';
import LocksAndOutagesTab from './components/LocksAndOutagesTab';
import RouteCountryTab from './components/RouteCountryTab';
import AirlineColorsTab from './components/AirlineColorsTab';
import AiAnalysisTab from './components/AiAnalysisTab';
import DashboardAlertsTab from './components/DashboardAlertsTab';
import SeasonRepairTab from './components/SeasonRepairTab';
import UpdatesTab from './components/UpdatesTab';
import UsersRolesTab from './components/UsersRolesTab';

type SettingsTab = 'checkinCounters' | 'gateAllocation' | 'locksAndOutages' | 'groups' | 'rules' | 'routeCountries' | 'airlineColors' | 'dashboardAlerts' | 'aiAnalysis' | 'usersRoles' | 'seasonRepair' | 'updates';

const emptySettings = (): OperationalSettings => hydrateOperationalSettings(null);

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function currentTimestamp(): number {
  return Date.now();
}

function splitCodes(value: string): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const item of value.split(',')) {
    const code = item.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function joinCodes(values: string[]): string {
  return values.join(', ');
}

function normalizeAirlineColorCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeAirlineColorValue(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function normalizeRouteCountryValue(value: string): string {
  return value.trim();
}

function normalizeAiModelId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeAiBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || null;
}

function aiProviderLabel(provider: AiAnalysisProvider): string {
  if (provider === 'deepseek') return 'DeepSeek';
  return provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Gemini';
}

function defaultBaseUrlForAiProvider(provider: AiAnalysisProvider): string {
  if (provider === 'deepseek') return DEFAULT_DEEPSEEK_BASE_URL;
  return provider === 'openai-compatible' ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' : '';
}

function defaultModelNameForAiProvider(provider: AiAnalysisProvider): string {
  if (provider === 'deepseek') return 'deepseek-v4-flash';
  return provider === 'openai-compatible' ? 'qwen-plus' : 'gemini-3-flash-preview';
}

function orderedRouteCountries(routeCountries: RouteCountryMapping[]): RouteCountryMapping[] {
  return [...routeCountries].sort((left, right) => (
    left.country.localeCompare(right.country) || left.route.localeCompare(right.route)
  ));
}

function orderedCounters(counters: CheckInCounterResource[]): CheckInCounterResource[] {
  return [...counters].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, undefined, { numeric: true })
  ));
}

function orderedGates(gates: GateResource[]): GateResource[] {
  return [...gates].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, undefined, { numeric: true })
  ));
}

function orderedGateGroups(groups: GateGroup[]): GateGroup[] {
  return [...groups].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  ));
}

function orderedGateLocks(locks: GateLock[]): GateLock[] {
  return [...locks].sort((left, right) => (
    left.start.localeCompare(right.start) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  ));
}

function orderedStandGateMappings(mappings: StandGateMapping[]): StandGateMapping[] {
  return [...mappings].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.stand - right.stand || left.gate - right.gate
  ));
}

function nextSortOrder(items: { sortOrder: number }[]): number {
  return items.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), 0) + 1;
}

function toggleId(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

function updateConditions(
  conditions: CounterRuleConditions,
  patch: Partial<CounterRuleConditions>
): CounterRuleConditions {
  return {
    aircraftTypes: patch.aircraftTypes ?? conditions.aircraftTypes,
    aircraftGroups: patch.aircraftGroups ?? conditions.aircraftGroups,
    airlineCodes: patch.airlineCodes ?? conditions.airlineCodes,
  };
}

function conditionSummary(rule: CounterAllocationRule, settings: OperationalSettings): string {
  const parts: string[] = [];
  if (rule.conditions.aircraftTypes.length > 0) parts.push(`Aircraft: ${joinCodes(rule.conditions.aircraftTypes)}`);
  if (rule.conditions.airlineCodes.length > 0) parts.push(`Airline: ${joinCodes(rule.conditions.airlineCodes)}`);
  if (rule.conditions.aircraftGroups.length > 0) {
    const names = rule.conditions.aircraftGroups.map((id) => settings.aircraftGroups.find((group) => group.id === id)?.name ?? id);
    parts.push(`A/C Group: ${names.join(', ')}`);
  }
  return parts.join(' | ') || 'No conditions';
}

export default function SettingsPage() {
  const searchParams = useCachedRouteSearchParams();
  const { dialogNode, showAlert, showConfirm } = useAppDialog();
  const [activeTab, setActiveTab] = useSessionState<SettingsTab>('settings:activeTab', 'checkinCounters');
  const [settings, setSettings] = useState<OperationalSettings>(() => emptySettings());
  const [savedSettings, setSavedSettings] = useState<OperationalSettings>(() => emptySettings());
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading settings...', 20, 'Preparing operational settings')
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupAircraftTypes, setGroupAircraftTypes] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [ruleAircraftTypes, setRuleAircraftTypes] = useState('');
  const [ruleAirlineCodes, setRuleAirlineCodes] = useState('');
  const [ruleAircraftGroups, setRuleAircraftGroups] = useState<string[]>([]);
  const [ruleCounterValue, setRuleCounterValue] = useState('1');
  const [rulePriorityScore, setRulePriorityScore] = useState('0');
  const [ruleSortOrder, setRuleSortOrder] = useState('0');
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [counterInventoryInput, setCounterInventoryInput] = useState('1-54, M1-M7, Transit');
  const [counterLabelDrafts, setCounterLabelDrafts] = useState<Record<string, string>>({});
  const [counterGroupName, setCounterGroupName] = useState('');
  const [counterGroupBhs, setCounterGroupBhs] = useState('');
  const [counterGroupCounterIds, setCounterGroupCounterIds] = useState<string[]>([]);
  const [lockName, setLockName] = useState('');
  const [lockCounterIds, setLockCounterIds] = useState<string[]>([]);
  const [lockStart, setLockStart] = useState('');
  const [lockEnd, setLockEnd] = useState('');
  const [lockReason, setLockReason] = useState('');
  const [lockEnabled, setLockEnabled] = useState(true);
  const [gateLabel, setGateLabel] = useState('11');
  const [gateGroupName, setGateGroupName] = useState('');
  const [gateGroupGateIds, setGateGroupGateIds] = useState<string[]>([]);
  const [gateLockName, setGateLockName] = useState('');
  const [gateLockGateIds, setGateLockGateIds] = useState<string[]>([]);
  const [gateLockStart, setGateLockStart] = useState('');
  const [gateLockEnd, setGateLockEnd] = useState('');
  const [gateLockReason, setGateLockReason] = useState('');
  const [gateLockEnabled, setGateLockEnabled] = useState(true);
  const [standMappingStand, setStandMappingStand] = useState('14');
  const [standMappingGate, setStandMappingGate] = useState('7');
  const [airlineColorCode, setAirlineColorCode] = useState('');
  const [airlineColorValue, setAirlineColorValue] = useState('#1D4ED8');
  const [aiModelLabel, setAiModelLabel] = useState('Gemini Flash');
  const [aiModelProvider, setAiModelProvider] = useState<AiAnalysisProvider>('gemini');
  const [aiModelName, setAiModelName] = useState('gemini-3-flash-preview');
  const [aiModelBaseUrl, setAiModelBaseUrl] = useState('');
  const [aiKeyProvider, setAiKeyProvider] = useState<AiAnalysisProvider>('gemini');
  const [aiKeyValue, setAiKeyValue] = useState('');
  const [aiKeyRotating, setAiKeyRotating] = useState(false);
  const [canManageAi, setCanManageAi] = useState(false);
  const [canUseAi, setCanUseAi] = useState(false);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [routeCountryRoute, setRouteCountryRoute] = useState('');
  const [routeCountryCountry, setRouteCountryCountry] = useState('');
  const [routeCountrySearch, setRouteCountrySearch] = useState('');
  const [routeCountryImportStatus, setRouteCountryImportStatus] = useState<string | null>(null);
  const [seasonRepairRunning, setSeasonRepairRunning] = useState(false);
  const [seasonRepairStatus, setSeasonRepairStatus] = useState<string | null>(null);
  const settingsScrollRef = useRef<HTMLElement | null>(null);
  useSessionScrollRestoration('settings:scroll', settingsScrollRef);

  const selectedSeasonId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const querySeasonId = searchParams.get('season');
    const storedSeasonId = sessionStorage.getItem('activeSeasonId') || sessionStorage.getItem('detailed_season');
    const resolvedSeasonId = querySeasonId || storedSeasonId || null;
    if (resolvedSeasonId) sessionStorage.setItem('activeSeasonId', resolvedSeasonId);
    return resolvedSeasonId;
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadProgress(buildLoadProgress('Loading settings...', 45, 'Fetching operational settings', { indeterminate: true }));
        const loaded = await getOperationalSettings();
        if (!cancelled) {
          setLoadProgress(buildLoadProgress('Rendering settings...', 90, 'Applying saved configuration'));
          setSettings(loaded);
          setSavedSettings(loaded);
        }
      } catch (err) {
        if (!cancelled) void showAlert({ title: 'Settings Load Failed', message: (err as Error).message, tone: 'error' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showAlert]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await getCurrentOperatorAccess();
        if (!cancelled) {
          setCanManageAi(access.canManageAi);
          setCanUseAi(access.canUseAi);
          setCanManageUsers(access.canManageUsers);
          setCanManageRoles(access.permissions.has('roles.manage'));
        }
      } catch {
        if (!cancelled) {
          setCanManageAi(false);
          setCanUseAi(false);
          setCanManageUsers(false);
          setCanManageRoles(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'usersRoles' && !canManageUsers) setActiveTab('checkinCounters');
  }, [activeTab, canManageUsers, setActiveTab]);

  const visibleTabs = useMemo(() => [
    { id: 'checkinCounters' as const, label: 'Counters' },
    { id: 'gateAllocation' as const, label: 'Gates & Stands' },
    { id: 'locksAndOutages' as const, label: 'Locks / Outages' },
    { id: 'groups' as const, label: 'A/C Groups' },
    { id: 'rules' as const, label: 'Allocation Rules' },
    { id: 'routeCountries' as const, label: 'Route-Country' },
    { id: 'airlineColors' as const, label: 'Airline Colors' },
    { id: 'dashboardAlerts' as const, label: 'Dashboard Alerts' },
    { id: 'aiAnalysis' as const, label: 'AI Analysis' },
    ...(canManageUsers ? [{ id: 'usersRoles' as const, label: 'Users & Roles' }] : []),
    { id: 'seasonRepair' as const, label: 'Season Repair' },
    { id: 'updates' as const, label: 'Updates' },
  ], [canManageUsers]);

  const isDirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [savedSettings, settings]);
  const checkInCounters = useMemo(() => orderedCounters(settings.checkInCounters), [settings.checkInCounters]);
  const gateResources = useMemo(() => orderedGates(settings.gateResources), [settings.gateResources]);
  const gateGroups = useMemo(() => orderedGateGroups(settings.gateGroups), [settings.gateGroups]);
  const gateLocks = useMemo(() => orderedGateLocks(settings.gateLocks), [settings.gateLocks]);
  const standGateMappings = useMemo(() => orderedStandGateMappings(settings.standGateMappings), [settings.standGateMappings]);
  const routeCountryRows = useMemo(() => {
    const query = routeCountrySearch.trim().toLowerCase();
    const rows = orderedRouteCountries(settings.routeCountries);
    if (!query) return rows;
    return rows.filter((row) => (
      row.route.toLowerCase().includes(query) ||
      row.country.toLowerCase().includes(query)
    ));
  }, [routeCountrySearch, settings.routeCountries]);

  const persistSettings = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const savingSnapshotString = JSON.stringify(settings);
      const normalized = validateOperationalSettings({ ...settings, updatedAt: currentTimestamp() });
      await saveOperationalSettings(normalized);
      setSettings((current) => resolveSettingsAfterSave(current, savingSnapshotString, normalized));
      setSavedSettings(normalized);
      void appendAuditLogEntry({
        seasonId: null,
        seasonCode: null,
        module: 'settings',
        category: 'settings',
        operation: 'Saved operational settings',
        targetFlightIds: [],
        targetFlightLabels: [],
        deltas: buildSettingsAuditDeltas(savedSettings, normalized),
      });
      setStatus('Settings saved');
    } catch (err) {
      void showAlert({ title: 'Settings Save Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  }, [savedSettings, settings, showAlert]);

  const addGroup = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      aircraftGroups: [
        ...current.aircraftGroups,
        {
          id: makeId('ACG'),
          name: groupName.trim(),
          aircraftTypes: splitCodes(groupAircraftTypes),
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setGroupName('');
    setGroupAircraftTypes('');
    setStatus('Unsaved A/C group added');
  };

  const updateGroup = (id: string, patch: { name?: string; aircraftTypes?: string[] }) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      aircraftGroups: current.aircraftGroups.map((group) => (
        group.id === id ? { ...group, ...patch, updatedAt: now } : group
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved A/C group change');
  };

  const deleteGroup = async (id: string) => {
    const group = settings.aircraftGroups.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete A/C Group',
      message: `Delete ${group?.name ?? 'this group'}? Rules that only use this group will be disabled.`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    try {
      setSettings((current) => removeAircraftGroupFromSettings(current, id, currentTimestamp()));
      setStatus('Unsaved A/C group deletion');
    } catch (err) {
      void showAlert({ title: 'Delete Failed', message: (err as Error).message, tone: 'error' });
    }
  };

  const addRule = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      counterAllocationRules: [
        ...current.counterAllocationRules,
        {
          id: makeId('CTR'),
          name: ruleName.trim(),
          enabled: ruleEnabled,
          priorityScore: Number(rulePriorityScore),
          sortOrder: Number(ruleSortOrder),
          createdAt: now,
          updatedAt: now,
          conditions: {
            aircraftTypes: splitCodes(ruleAircraftTypes),
            aircraftGroups: ruleAircraftGroups,
            airlineCodes: splitCodes(ruleAirlineCodes),
          },
          counterValue: Number(ruleCounterValue),
        },
      ],
      updatedAt: now,
    }));
    setRuleName('');
    setRuleAircraftTypes('');
    setRuleAirlineCodes('');
    setRuleAircraftGroups([]);
    setRuleCounterValue('1');
    setRulePriorityScore('0');
    setRuleSortOrder(String(settings.counterAllocationRules.length + 1));
    setRuleEnabled(true);
    setStatus('Unsaved counter rule added');
  };

  const updateRule = (id: string, patch: Partial<CounterAllocationRule>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      counterAllocationRules: current.counterAllocationRules.map((rule) => (
        rule.id === id ? { ...rule, ...patch, updatedAt: now } : rule
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved counter rule change');
  };

  const deleteRule = async (id: string) => {
    const rule = settings.counterAllocationRules.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Counter Rule',
      message: `Delete ${rule?.name ?? 'this rule'}?`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      counterAllocationRules: current.counterAllocationRules.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Unsaved counter rule deletion');
  };

  const toggleDraftGroup = (groupId: string) => {
    setRuleAircraftGroups((current) => (
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]
    ));
  };

  const toggleRuleGroup = (rule: CounterAllocationRule, groupId: string) => {
    const current = rule.conditions.aircraftGroups;
    const nextGroups = current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId];
    updateRule(rule.id, { conditions: updateConditions(rule.conditions, { aircraftGroups: nextGroups }) });
  };

  const toggleDraftCounterGroupCounter = (counterId: string) => {
    setCounterGroupCounterIds((current) => toggleId(current, counterId));
  };

  const toggleDraftLockCounter = (counterId: string) => {
    setLockCounterIds((current) => toggleId(current, counterId));
  };

  const toggleDraftGateGroupGate = (gateId: string) => {
    setGateGroupGateIds((current) => toggleId(current, gateId));
  };

  const toggleDraftGateLockGate = (gateId: string) => {
    setGateLockGateIds((current) => toggleId(current, gateId));
  };

  const addCheckInCounters = () => {
    const parsed = parseCheckInCounterInventoryInput(counterInventoryInput);
    const existingLabels = new Set(settings.checkInCounters.map((counter) => counter.label.trim().toLowerCase()));
    const newLabels = parsed
      .map((counter) => counter.label.trim())
      .filter((label) => label && !existingLabels.has(label.toLowerCase()));
    if (newLabels.length === 0) {
      void showAlert({ title: 'No Counters Added', message: 'Enter at least one new check-in counter label.', tone: 'warning' });
      return;
    }
    const now = currentTimestamp();
    const firstSortOrder = nextSortOrder(settings.checkInCounters);
    setSettings((current) => ({
      ...current,
      checkInCounters: [
        ...current.checkInCounters,
        ...newLabels.map((label, index) => ({
          id: makeId('CIC'),
          label,
          enabled: true,
          sortOrder: firstSortOrder + index,
          createdAt: now,
          updatedAt: now,
        })),
      ],
      updatedAt: now,
    }));
    setStatus(`Unsaved ${newLabels.length} check-in counter${newLabels.length === 1 ? '' : 's'} added`);
  };

  const updateCheckInCounter = (id: string, patch: Partial<CheckInCounterResource>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      checkInCounters: current.checkInCounters.map((counter) => (
        counter.id === id ? { ...counter, ...patch, updatedAt: now } : counter
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved check-in counter change');
  };

  const confirmCheckInCounterLabelChange = async (counter: CheckInCounterResource, nextLabel: string) => {
    const normalizedLabel = nextLabel.trim();
    if (normalizedLabel === counter.label) {
      setCounterLabelDrafts((current) => {
        const rest = { ...current };
        delete rest[counter.id];
        return rest;
      });
      return;
    }
    if (!normalizedLabel) {
      setCounterLabelDrafts((current) => ({ ...current, [counter.id]: counter.label }));
      void showAlert({ title: 'Counter Label Required', message: 'Check-in counter labels cannot be blank.', tone: 'warning' });
      return;
    }
    const confirmed = await showConfirm({
      title: 'Rename Counter',
      message: `Changing a counter label can affect existing groups, locks, and allocations. Rename ${counter.label} to ${normalizedLabel || 'blank'}?`,
      tone: 'warning',
      confirmLabel: 'Rename',
    });
    if (!confirmed) {
      setCounterLabelDrafts((current) => ({ ...current, [counter.id]: counter.label }));
      return;
    }
    setSettings((current) => renameCheckInCounterLabelInSettings(current, counter.id, normalizedLabel, currentTimestamp()));
    setStatus('Unsaved check-in counter change');
    setCounterLabelDrafts((current) => {
      const rest = { ...current };
      delete rest[counter.id];
      return rest;
    });
  };

  const deleteCheckInCounter = async (id: string) => {
    const counter = settings.checkInCounters.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Counter',
      message: `Delete counter ${counter?.label ?? 'this counter'}? It will be removed from counter groups and locks.`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const now = currentTimestamp();
    setSettings((current) => deleteCheckInCounterFromSettings(current, id, now));
    setCounterGroupCounterIds((current) => current.filter((counterId) => counterId !== id));
    setLockCounterIds((current) => current.filter((counterId) => counterId !== id));
    setStatus('Unsaved check-in counter deletion');
  };

  const addCheckInCounterGroup = () => {
    const now = currentTimestamp();
    const groupId = makeId('CIG');
    const selectedIds = [...counterGroupCounterIds];
    setSettings((current) => ({
      ...current,
      checkInCounterGroups: [
        ...current.checkInCounterGroups.map((group) => ({
          ...group,
          counterIds: group.counterIds.filter((counterId) => !selectedIds.includes(counterId)),
          updatedAt: group.counterIds.some((counterId) => selectedIds.includes(counterId)) ? now : group.updatedAt,
        })),
        {
          id: groupId,
          name: counterGroupName.trim(),
          bhs: counterGroupBhs.trim(),
          counterIds: selectedIds,
          sortOrder: nextSortOrder(current.checkInCounterGroups),
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setCounterGroupName('');
    setCounterGroupBhs('');
    setCounterGroupCounterIds([]);
    setStatus('Unsaved counter group added');
  };

  const updateCheckInCounterGroup = (id: string, patch: Partial<CheckInCounterGroup>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      checkInCounterGroups: current.checkInCounterGroups.map((group) => (
        group.id === id ? { ...group, ...patch, updatedAt: now } : group
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved counter group change');
  };

  const toggleCheckInCounterGroupCounter = (groupId: string, counterId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleCheckInCounterGroupMembership(current, groupId, counterId, now));
    setStatus('Unsaved counter group membership change');
  };

  const deleteCheckInCounterGroup = async (id: string) => {
    const group = settings.checkInCounterGroups.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Counter Group',
      message: `Delete ${group?.name ?? 'this counter group'}? Counter inventory and locks will remain.`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      checkInCounterGroups: current.checkInCounterGroups.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Unsaved counter group deletion');
  };

  const addCheckInCounterLock = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      checkInCounterLocks: [
        ...current.checkInCounterLocks,
        {
          id: makeId('CIL'),
          name: lockName.trim(),
          counterIds: [...lockCounterIds],
          start: lockStart,
          end: lockEnd,
          reason: lockReason.trim() || null,
          enabled: lockEnabled,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setLockName('');
    setLockCounterIds([]);
    setLockStart('');
    setLockEnd('');
    setLockReason('');
    setLockEnabled(true);
    setStatus('Unsaved counter lock added');
  };

  const updateCheckInCounterLock = (id: string, patch: Partial<CheckInCounterLock>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      checkInCounterLocks: current.checkInCounterLocks.map((lock) => (
        lock.id === id ? { ...lock, ...patch, updatedAt: now } : lock
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved counter lock change');
  };

  const toggleCheckInCounterLockCounter = (lock: CheckInCounterLock, counterId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleCheckInCounterLockMembership(current, lock.id, counterId, now));
    setStatus('Unsaved counter lock change');
  };

  const deleteCheckInCounterLock = async (id: string) => {
    const lock = settings.checkInCounterLocks.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Counter Lock',
      message: `Delete ${lock?.name ?? 'this counter lock'}?`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      checkInCounterLocks: current.checkInCounterLocks.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Unsaved counter lock deletion');
  };

  const updateGateResource = (id: string, patch: Partial<GateResource>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      gateResources: current.gateResources.map((gate) => (
        gate.id === id ? { ...gate, ...patch, updatedAt: now } : gate
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved gate change');
  };

  const addGateResource = () => {
    const label = gateLabel.trim();
    if (!label) {
      void showAlert({ title: 'No Gate Added', message: 'Enter a gate label before adding.', tone: 'warning' });
      return;
    }
    if (settings.gateResources.some((gate) => gate.label.trim().toLowerCase() === label.toLowerCase())) {
      void showAlert({ title: 'No Gate Added', message: `Gate ${label} already exists.`, tone: 'warning' });
      return;
    }
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      gateResources: [
        ...current.gateResources,
        {
          id: makeId('GATE'),
          label,
          enabled: true,
          sortOrder: nextSortOrder(current.gateResources),
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setGateLabel('');
    setStatus(`Unsaved gate ${label} added`);
  };

  const deleteGateResource = async (id: string) => {
    const gate = settings.gateResources.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Gate',
      message: `Delete gate ${gate?.label ?? 'this gate'}? It will be removed from gate groups and gate locks.`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const now = currentTimestamp();
    setSettings((current) => deleteGateFromSettings(current, id, now));
    setGateGroupGateIds((current) => current.filter((gateId) => gateId !== id));
    setGateLockGateIds((current) => current.filter((gateId) => gateId !== id));
    setStatus('Unsaved gate deletion');
  };

  const updateGateGroup = (id: string, patch: Partial<GateGroup>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      gateGroups: current.gateGroups.map((group) => (
        group.id === id ? { ...group, ...patch, updatedAt: now } : group
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved gate group change');
  };

  const addGateGroup = () => {
    const now = currentTimestamp();
    const selectedIds = [...gateGroupGateIds];
    setSettings((current) => ({
      ...current,
      gateGroups: [
        ...current.gateGroups.map((group) => ({
          ...group,
          gateIds: group.gateIds.filter((gateId) => !selectedIds.includes(gateId)),
          updatedAt: group.gateIds.some((gateId) => selectedIds.includes(gateId)) ? now : group.updatedAt,
        })),
        {
          id: makeId('GATEG'),
          name: gateGroupName.trim(),
          gateIds: selectedIds,
          sortOrder: nextSortOrder(current.gateGroups),
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setGateGroupName('');
    setGateGroupGateIds([]);
    setStatus('Unsaved gate group added');
  };

  const toggleGateGroupGate = (groupId: string, gateId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleGateGroupMembership(current, groupId, gateId, now));
    setStatus('Unsaved gate group membership change');
  };

  const addGateLock = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      gateLocks: [
        ...current.gateLocks,
        {
          id: makeId('GATEL'),
          name: gateLockName.trim(),
          gateIds: [...gateLockGateIds],
          start: gateLockStart,
          end: gateLockEnd,
          reason: gateLockReason.trim() || null,
          enabled: gateLockEnabled,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setGateLockName('');
    setGateLockGateIds([]);
    setGateLockStart('');
    setGateLockEnd('');
    setGateLockReason('');
    setGateLockEnabled(true);
    setStatus('Unsaved gate lock added');
  };

  const updateGateLock = (id: string, patch: Partial<GateLock>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      gateLocks: current.gateLocks.map((lock) => (
        lock.id === id ? { ...lock, ...patch, updatedAt: now } : lock
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved gate lock change');
  };

  const toggleGateLockGate = (lock: GateLock, gateId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleGateLockMembership(current, lock.id, gateId, now));
    setStatus('Unsaved gate lock change');
  };

  const deleteGateLock = async (id: string) => {
    const lock = settings.gateLocks.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Delete Gate Lock',
      message: `Delete ${lock?.name ?? 'this gate lock'}?`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      gateLocks: current.gateLocks.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Unsaved gate lock deletion');
  };

  const addStandGateMapping = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      standGateMappings: [
        ...current.standGateMappings,
        {
          id: makeId('SGM'),
          stand: Number(standMappingStand),
          gate: Number(standMappingGate),
          sortOrder: nextSortOrder(current.standGateMappings),
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setStatus('Unsaved stand-gate mapping added');
  };

  const updateStandGateMapping = (id: string, patch: Partial<StandGateMapping>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      standGateMappings: current.standGateMappings.map((mapping) => (
        mapping.id === id ? { ...mapping, ...patch, updatedAt: now } : mapping
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved stand-gate mapping change');
  };

  const deleteStandGateMapping = (id: string) => {
    setSettings((current) => ({
      ...current,
      standGateMappings: current.standGateMappings.filter((mapping) => mapping.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Unsaved stand-gate mapping deletion');
  };

  const addOrUpdateRouteCountry = () => {
    const route = normalizeRouteCode(routeCountryRoute);
    const country = normalizeRouteCountryValue(routeCountryCountry);
    if (!route || !country) {
      void showAlert({ title: 'Route-Country Failed', message: 'Route and country are required.', tone: 'error' });
      return;
    }
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      routeCountries: [
        ...current.routeCountries.filter((item) => item.route !== route),
        { route, country },
      ],
      updatedAt: now,
    }));
    setRouteCountryRoute('');
    setRouteCountryCountry('');
    setRouteCountryImportStatus(null);
    setStatus('Unsaved route-country change');
  };

  const updateRouteCountry = (route: string, patch: Partial<RouteCountryMapping>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      routeCountries: current.routeCountries.map((item) => (
        item.route === route
          ? {
              route: patch.route == null ? item.route : normalizeRouteCode(patch.route),
              country: patch.country == null ? item.country : normalizeRouteCountryValue(patch.country),
            }
          : item
      )),
      updatedAt: now,
    }));
    setRouteCountryImportStatus(null);
    setStatus('Unsaved route-country change');
  };

  const deleteRouteCountry = async (route: string) => {
    const confirmed = await showConfirm({
      title: 'Delete Route-Country',
      message: `Delete country mapping for route ${route}? Dashboard rows for that route will become Unknown after saving.`,
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      routeCountries: current.routeCountries.filter((item) => item.route !== route),
      updatedAt: currentTimestamp(),
    }));
    setRouteCountryImportStatus(null);
    setStatus('Unsaved route-country deletion');
  };

  const handleRouteCountryImport = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('Import file does not contain a readable worksheet.');
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' });
      const parsed = parseRouteCountryRows(rows);
      if (parsed.entries.length === 0) {
        throw new Error('No valid Route / Country rows found in the uploaded file.');
      }
      const existingRoutes = new Set(settings.routeCountries.map((item) => normalizeRouteCode(item.route)));
      const updatedRoutes = parsed.entries.filter((entry) => existingRoutes.has(entry.route)).length;
      const addedRoutes = parsed.entries.length - updatedRoutes;
      const confirmed = await showConfirm({
        title: 'Update Route-Country Map',
        message: `Update ${updatedRoutes} existing routes and add ${addedRoutes} new routes from ${file.name}? Routes not included in the file will be kept.`,
        tone: 'warning',
        confirmLabel: 'Update Map',
      });
      if (!confirmed) return;
      const now = currentTimestamp();
      setSettings((current) => ({
        ...current,
        routeCountries: mergeRouteCountryMappings(current.routeCountries, parsed.entries),
        updatedAt: now,
      }));
      const importNotes = [
        `${updatedRoutes} routes updated`,
        `${addedRoutes} routes added`,
        parsed.duplicateRoutes.length > 0 ? `${parsed.duplicateRoutes.length} duplicate routes replaced by last row` : null,
        parsed.invalidRows.length > 0 ? `${parsed.invalidRows.length} invalid rows skipped` : null,
      ].filter(Boolean).join(' | ');
      setRouteCountryImportStatus(importNotes);
      setStatus('Unsaved route-country import update');
    } catch (err) {
      void showAlert({ title: 'Route-Country Import Failed', message: (err as Error).message, tone: 'error' });
    }
  }, [settings.routeCountries, showAlert, showConfirm]);

  const handleSeasonRepairImport = useCallback(async (file: File | null) => {
    if (!file || seasonRepairRunning) return;
    setSeasonRepairRunning(true);
    setSeasonRepairStatus(`Reading ${file.name}`);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const { seasonCode, rows: parsedRows } = parseSeasonalSchedule(workbook);
      if (parsedRows.length === 0) throw new Error('File contains no valid seasonal rows.');

      const duplicateMerge = mergeDuplicateImportPeriods(parsedRows);
      const rows = duplicateMerge.rows;
      const recordDuplicateMerge = mergeDuplicateImportRecords(flattenRowsToFlightRecords(rows));
      const duplicatePeriods = [
        ...duplicateMerge.duplicatePeriods,
        ...recordDuplicateMerge.duplicatePeriods,
      ];
      const records = recordDuplicateMerge.records;
      assertNoDuplicateFlightNumbers(records);

      const legs = flightRecordsToLegs(records);
      const dates = legs.map((leg) => leg.date).sort();
      const existing = await findSeasonByCode(seasonCode);
      const syncSummary = existing ? await queryNativeSyncSummary(existing.id) : null;
      const pendingCount = syncSummary?.pendingCount ?? 0;
      const conflictCount = syncSummary?.conflictCount ?? 0;
      const syncRiskParts = [
        pendingCount > 0 ? `${pendingCount} pending local change${pendingCount === 1 ? '' : 's'}` : null,
        conflictCount > 0 ? `${conflictCount} conflict review item${conflictCount === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      const pendingNote = syncRiskParts.length > 0
        ? `\n\nThis season has ${syncRiskParts.join(' and ')} that will be discarded by the repair import.`
        : '';
      const confirmed = await showConfirm({
        title: 'Replace Full Season',
        message:
          `Replace the full ${seasonCode} baseline with ${records.length} flight records from ${file.name}? ` +
          'This clears existing baseline records, modifications, and history for that season before recreating it.' +
          pendingNote,
        tone: 'warning',
        confirmLabel: existing ? 'Replace Season' : 'Create Season',
      });
      if (!confirmed) {
        setSeasonRepairStatus(null);
        return;
      }

      const uploadedAt = Date.now();
      const seasonFields = {
        seasonCode,
        name: buildSeasonNameFromFileName(file.name, seasonCode),
        fileName: file.name,
        uploadedAt,
        effectiveStart: dates[0] || '',
        effectiveEnd: dates[dates.length - 1] || '',
        totalLegs: legs.length,
        totalSourceRows: 0,
        dataVersion: (existing?.dataVersion ?? 0) + 1,
        lastSyncedAt: uploadedAt,
      };

      setSeasonRepairStatus(existing ? `Clearing ${seasonCode}` : `Creating ${seasonCode}`);
      let seasonId: string;
      let nextSeason: Season;
      if (existing) {
        seasonId = existing.id;
        await clearSeasonBaseline(seasonId);
        await updateSeason(seasonId, seasonFields);
        nextSeason = { ...existing, ...seasonFields, id: seasonId };
      } else {
        seasonId = await createSeason(seasonFields as Omit<Season, 'id'>);
        nextSeason = { ...seasonFields, id: seasonId } as Season;
      }

      setSeasonRepairStatus(`Writing ${records.length} flight records`);
      await batchWriteFlightRecords(seasonId, records);
      const verifiedCounts = await verifySeasonImportCounts(seasonId, {
        sourceRows: 0,
        flightRecords: records.length,
      });
      const serverEventHighWater = await getSeasonEventHighWater(seasonId);
      const canonical = buildCanonicalSeasonalRows({ records, modifications: new Map() });
      if (!canonical.validation.valid) {
        console.warn('Canonical seasonal pattern validation failed after repair import', canonical.diagnostics);
      }

      setSeasonRepairStatus(`Refreshing local SQL for ${seasonCode}`);
      const imported = await importNativeSeasonSnapshot({
        season: nextSeason,
        sourceRows: [],
        records,
        modifications: [],
        modHistory: [],
        serverEventHighWater,
        entityVersions: {},
      });
      if (!imported) {
        throw new Error('Native SQL snapshot import is unavailable. Desktop SQL storage is required.');
      }
      if (
        imported.sourceRows !== 0 ||
        imported.records !== records.length ||
        imported.modifications !== 0 ||
        imported.modHistory !== 0
      ) {
        throw new Error(
          `Local SQL repair import count mismatch: sourceRows=${imported.sourceRows}/0, records=${imported.records}/${records.length}, modifications=${imported.modifications}/0, history=${imported.modHistory}/0.`
        );
      }
      const localIntegrity = await checkNativeSeasonIntegrity(seasonId);
      if (!localIntegrity) {
        throw new Error('Native SQL integrity check is unavailable after repair import.');
      }
      if (
        localIntegrity.sourceRows !== 0 ||
        localIntegrity.baseSourceRows !== 0 ||
        localIntegrity.records !== records.length ||
        localIntegrity.baseRecords !== records.length ||
        localIntegrity.pendingOps !== 0
      ) {
        throw new Error(
          `Local SQL integrity mismatch after repair import: sourceRows=${localIntegrity.sourceRows}/0, baseSourceRows=${localIntegrity.baseSourceRows}/0, records=${localIntegrity.records}/${records.length}, baseRecords=${localIntegrity.baseRecords}/${records.length}, pendingOps=${localIntegrity.pendingOps}/0.`
        );
      }

      const previousSeasons = getCachedSeasons() ?? await getSeasons();
      const nextSeasons = existing
        ? previousSeasons.map((season) => season.id === seasonId ? nextSeason : season)
        : [nextSeason, ...previousSeasons];
      setCachedSeasons(nextSeasons);
      setCachedSeasonData(seasonId, {
        rows: canonical.rows,
        records,
        modifications: new Map(),
        seasonDataVersion: nextSeason.dataVersion,
      });
      publishSeasonWorkspaceChanged({
        seasonId,
        localRevision: imported.syncMeta.localRevision,
        source: 'settings',
        syncMeta: imported.syncMeta,
      });
      void appendAuditLogEntry({
        seasonId,
        seasonCode,
        module: 'settings',
        category: 'import',
        operation: `Full replace repair import for season ${seasonCode}: ${records.length} flight records`,
        targetFlightIds: records.map((record) => record.id),
        targetFlightLabels: Array.from(new Set(records.map((record) => `${record.airline}${record.flightNumber}`))).slice(0, 200),
        deltas: [{
          targetType: 'sync',
          targetId: seasonId,
          targetLabel: seasonCode,
          field: 'repairImportSummary',
          before: null,
          after: {
            sourceRows: 0,
            flightRecords: records.length,
            effectiveStart: nextSeason.effectiveStart,
            effectiveEnd: nextSeason.effectiveEnd,
            fileName: file.name,
            duplicatePeriods: duplicatePeriods.length,
          },
        }],
      });
      setSeasonRepairStatus(`Replaced ${seasonCode}: ${verifiedCounts.flightRecords} flight records`);
      void showAlert({
        title: 'Season Repair Import Complete',
        message: duplicatePeriods.length > 0
          ? `Replaced ${seasonCode}. ${duplicatePeriods.length} duplicate overlapping period${duplicatePeriods.length === 1 ? '' : 's'} were merged.`
          : `Replaced ${seasonCode} with ${verifiedCounts.flightRecords} flight records.`,
        tone: duplicatePeriods.length > 0 ? 'warning' : 'success',
      });
    } catch (err) {
      setSeasonRepairStatus('Repair import failed');
      void showAlert({ title: 'Season Repair Import Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setSeasonRepairRunning(false);
    }
  }, [seasonRepairRunning, showAlert, showConfirm]);

  const updateAirlineColor = (airlineCode: string, patch: Partial<AirlineColorSetting>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      airlineColors: current.airlineColors.map((item) => (
        item.airlineCode === airlineCode
          ? {
              airlineCode: patch.airlineCode == null ? item.airlineCode : normalizeAirlineColorCode(patch.airlineCode),
              color: patch.color == null ? item.color : normalizeAirlineColorValue(patch.color),
            }
          : item
      )),
      updatedAt: now,
    }));
    setStatus('Unsaved airline color change');
  };

  const addAirlineColor = () => {
    const code = normalizeAirlineColorCode(airlineColorCode);
    const color = normalizeAirlineColorValue(airlineColorValue);
    if (!code) {
      void showAlert({ title: 'Add Airline Color Failed', message: 'Airline code is required.', tone: 'error' });
      return;
    }
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      airlineColors: [
        ...current.airlineColors.filter((item) => item.airlineCode !== code),
        { airlineCode: code, color },
      ],
      updatedAt: now,
    }));
    setAirlineColorCode('');
    setAirlineColorValue('#1D4ED8');
    setStatus('Unsaved airline color added');
  };

  const deleteAirlineColor = (airlineCode: string) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      airlineColors: current.airlineColors.filter((item) => item.airlineCode !== airlineCode),
      updatedAt: now,
    }));
    setStatus('Unsaved airline color deletion');
  };

  const updateAiModel = (modelId: string, patch: Partial<AiAnalysisModelSetting>) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      aiAnalysis: {
        ...current.aiAnalysis,
        models: current.aiAnalysis.models.map((model) => (
          model.id === modelId
            ? {
                ...model,
                ...patch,
                id: patch.id == null ? model.id : normalizeAiModelId(patch.id),
                label: patch.label == null ? model.label : patch.label.trim(),
                model: patch.model == null ? model.model : patch.model.trim(),
                baseUrl: patch.provider === 'gemini'
                  ? null
                  : patch.baseUrl == null
                    ? model.baseUrl
                    : normalizeAiBaseUrl(patch.baseUrl),
              }
            : model
        )),
        updatedAt: now,
      },
      updatedAt: now,
    }));
    setStatus('Unsaved AI Analysis change');
  };

  const addAiModel = () => {
    const label = aiModelLabel.trim();
    const modelName = aiModelName.trim();
    const id = normalizeAiModelId(label || modelName);
    if (!id || !label || !modelName) {
      void showAlert({ title: 'Add AI Model Failed', message: 'Model label and provider model name are required.', tone: 'error' });
      return;
    }
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      aiAnalysis: {
        ...current.aiAnalysis,
        models: [
          ...current.aiAnalysis.models.filter((model) => model.id !== id),
          {
            id,
            label,
            provider: aiModelProvider,
            model: modelName,
            baseUrl: aiModelProvider === 'gemini' ? null : normalizeAiBaseUrl(aiModelBaseUrl || defaultBaseUrlForAiProvider(aiModelProvider)),
            enabled: true,
            keyUpdatedAt: null,
          },
        ],
        activeModelId: current.aiAnalysis.activeModelId || id,
        updatedAt: now,
      },
      updatedAt: now,
    }));
    setAiModelLabel('');
    setAiModelName('');
    setAiModelBaseUrl(defaultBaseUrlForAiProvider(aiModelProvider));
    setStatus('Unsaved AI model added');
  };

  const deleteAiModel = (modelId: string) => {
    const now = currentTimestamp();
    setSettings((current) => {
      const models = current.aiAnalysis.models.filter((model) => model.id !== modelId);
      return {
        ...current,
        aiAnalysis: {
          ...current.aiAnalysis,
          models,
          activeModelId: current.aiAnalysis.activeModelId === modelId ? models[0]?.id ?? '' : current.aiAnalysis.activeModelId,
          updatedAt: now,
        },
        updatedAt: now,
      };
    });
    setStatus('Unsaved AI model deletion');
  };

  const rotateAiProviderKey = async () => {
    if (!canManageAi) {
      void showAlert({ title: 'AI Key Sync Blocked', message: 'Your operator grant does not include can_manage_ai.', tone: 'error' });
      return;
    }
    setAiKeyRotating(true);
    try {
      const result = await syncDashboardAiProviderKey({ provider: aiKeyProvider, apiKey: aiKeyValue });
      const now = result.keyUpdatedAt;
      setSettings((current) => ({
        ...current,
        aiAnalysis: {
          ...current.aiAnalysis,
          models: current.aiAnalysis.models.map((model) => (
            model.provider === result.provider ? { ...model, keyUpdatedAt: now } : model
          )),
          updatedAt: now,
        },
        updatedAt: now,
      }));
      setAiKeyValue('');
      setStatus(`${aiProviderLabel(result.provider)} key synced for local AI`);
    } catch (err) {
      void showAlert({ title: 'Sync Provider Key Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setAiKeyRotating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface text-on-surface">
        <LoadingStatusPanel progress={loadProgress} mode="fullscreen" icon="settings" />
        {dialogNode}
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface text-on-surface">
      <div className="flex h-dvh min-w-0 flex-1 flex-col">
        <header className="z-30 flex flex-none items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Settings</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Global operational configuration</p>
          </div>
          <div className="flex items-center gap-3">
            {status && <span className="text-sm text-on-surface-variant">{status}</span>}
            {isDirty && <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800"><span className="h-2 w-2 rounded-full bg-amber-500" />Unsaved changes</span>}
            <button
              type="button"
              onClick={persistSettings}
              disabled={saving || !isDirty}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[18px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'progress_activity' : 'save'}</span>
              {saving ? 'Saving' : 'Save Settings'}
            </button>
          </div>
        </header>

        <main ref={settingsScrollRef} className="flex-1 overflow-y-auto p-6">
          <div className="mb-5 flex gap-2 overflow-x-auto whitespace-nowrap border-b border-surface-variant [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-semibold transition-colors ${activeTab === tab.id ? 'border-b-2 border-primary text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'checkinCounters' && (
            <CheckInCountersTab
              settings={settings}
              checkInCounters={checkInCounters}
              counterInventoryInput={counterInventoryInput}
              setCounterInventoryInput={setCounterInventoryInput}
              counterLabelDrafts={counterLabelDrafts}
              setCounterLabelDrafts={setCounterLabelDrafts}
              counterGroupName={counterGroupName}
              setCounterGroupName={setCounterGroupName}
              counterGroupBhs={counterGroupBhs}
              setCounterGroupBhs={setCounterGroupBhs}
              counterGroupCounterIds={counterGroupCounterIds}
              addCheckInCounters={addCheckInCounters}
              updateCheckInCounter={updateCheckInCounter}
              confirmCheckInCounterLabelChange={confirmCheckInCounterLabelChange}
              deleteCheckInCounter={deleteCheckInCounter}
              toggleDraftCounterGroupCounter={toggleDraftCounterGroupCounter}
              addCheckInCounterGroup={addCheckInCounterGroup}
              updateCheckInCounterGroup={updateCheckInCounterGroup}
              toggleCheckInCounterGroupCounter={toggleCheckInCounterGroupCounter}
              deleteCheckInCounterGroup={deleteCheckInCounterGroup}
            />
          )}

          {activeTab === 'gateAllocation' && (
            <GatesTab
              gateResources={gateResources}
              gateGroups={gateGroups}
              standGateMappings={standGateMappings}
              standMappingStand={standMappingStand}
              setStandMappingStand={setStandMappingStand}
              standMappingGate={standMappingGate}
              setStandMappingGate={setStandMappingGate}
              addStandGateMapping={addStandGateMapping}
              updateStandGateMapping={updateStandGateMapping}
              deleteStandGateMapping={deleteStandGateMapping}
              gateLabel={gateLabel}
              setGateLabel={setGateLabel}
              addGateResource={addGateResource}
              updateGateResource={updateGateResource}
              deleteGateResource={deleteGateResource}
              gateGroupName={gateGroupName}
              setGateGroupName={setGateGroupName}
              gateGroupGateIds={gateGroupGateIds}
              toggleDraftGateGroupGate={toggleDraftGateGroupGate}
              addGateGroup={addGateGroup}
              updateGateGroup={updateGateGroup}
              toggleGateGroupGate={toggleGateGroupGate}
            />
          )}

          {activeTab === 'locksAndOutages' && (
            <LocksAndOutagesTab
              settings={settings}
              checkInCounters={checkInCounters}
              gateResources={gateResources}
              gateLocks={gateLocks}
              lockName={lockName}
              setLockName={setLockName}
              lockCounterIds={lockCounterIds}
              lockStart={lockStart}
              setLockStart={setLockStart}
              lockEnd={lockEnd}
              setLockEnd={setLockEnd}
              lockReason={lockReason}
              setLockReason={setLockReason}
              lockEnabled={lockEnabled}
              setLockEnabled={setLockEnabled}
              gateLockName={gateLockName}
              setGateLockName={setGateLockName}
              gateLockGateIds={gateLockGateIds}
              gateLockStart={gateLockStart}
              setGateLockStart={setGateLockStart}
              gateLockEnd={gateLockEnd}
              setGateLockEnd={setGateLockEnd}
              gateLockReason={gateLockReason}
              setGateLockReason={setGateLockReason}
              gateLockEnabled={gateLockEnabled}
              setGateLockEnabled={setGateLockEnabled}
              toggleDraftLockCounter={toggleDraftLockCounter}
              addCheckInCounterLock={addCheckInCounterLock}
              updateCheckInCounterLock={updateCheckInCounterLock}
              toggleCheckInCounterLockCounter={toggleCheckInCounterLockCounter}
              deleteCheckInCounterLock={deleteCheckInCounterLock}
              toggleDraftGateLockGate={toggleDraftGateLockGate}
              addGateLock={addGateLock}
              updateGateLock={updateGateLock}
              toggleGateLockGate={toggleGateLockGate}
              deleteGateLock={deleteGateLock}
            />
          )}

          {activeTab === 'groups' && (
            <AcGroupTab
              settings={settings}
              groupName={groupName}
              setGroupName={setGroupName}
              groupAircraftTypes={groupAircraftTypes}
              setGroupAircraftTypes={setGroupAircraftTypes}
              addGroup={addGroup}
              updateGroup={updateGroup}
              deleteGroup={deleteGroup}
              joinCodes={joinCodes}
              splitCodes={splitCodes}
            />
          )}

          {activeTab === 'rules' && (
            <RulesTab
              settings={settings}
              ruleName={ruleName}
              setRuleName={setRuleName}
              ruleAircraftTypes={ruleAircraftTypes}
              setRuleAircraftTypes={setRuleAircraftTypes}
              ruleAirlineCodes={ruleAirlineCodes}
              setRuleAirlineCodes={setRuleAirlineCodes}
              ruleAircraftGroups={ruleAircraftGroups}
              ruleCounterValue={ruleCounterValue}
              setRuleCounterValue={setRuleCounterValue}
              rulePriorityScore={rulePriorityScore}
              setRulePriorityScore={setRulePriorityScore}
              ruleSortOrder={ruleSortOrder}
              setRuleSortOrder={setRuleSortOrder}
              ruleEnabled={ruleEnabled}
              setRuleEnabled={setRuleEnabled}
              addRule={addRule}
              updateRule={updateRule}
              deleteRule={deleteRule}
              toggleDraftGroup={toggleDraftGroup}
              toggleRuleGroup={toggleRuleGroup}
              conditionSummary={conditionSummary}
              joinCodes={joinCodes}
              splitCodes={splitCodes}
              updateConditions={updateConditions}
            />
          )}

          {activeTab === 'routeCountries' && (
            <RouteCountryTab
              settings={settings}
              routeCountryRoute={routeCountryRoute}
              setRouteCountryRoute={setRouteCountryRoute}
              routeCountryCountry={routeCountryCountry}
              setRouteCountryCountry={setRouteCountryCountry}
              routeCountrySearch={routeCountrySearch}
              setRouteCountrySearch={setRouteCountrySearch}
              routeCountryImportStatus={routeCountryImportStatus}
              routeCountryRows={routeCountryRows}
              addOrUpdateRouteCountry={addOrUpdateRouteCountry}
              updateRouteCountry={updateRouteCountry}
              deleteRouteCountry={deleteRouteCountry}
              handleRouteCountryImport={handleRouteCountryImport}
            />
          )}

          {activeTab === 'airlineColors' && (
            <AirlineColorsTab
              settings={settings}
              airlineColorCode={airlineColorCode}
              setAirlineColorCode={setAirlineColorCode}
              airlineColorValue={airlineColorValue}
              setAirlineColorValue={setAirlineColorValue}
              normalizeAirlineColorValue={normalizeAirlineColorValue}
              addAirlineColor={addAirlineColor}
              updateAirlineColor={updateAirlineColor}
              deleteAirlineColor={deleteAirlineColor}
            />
          )}

          {activeTab === 'dashboardAlerts' && (
            <DashboardAlertsTab
              settings={settings}
              setSettings={setSettings}
              setStatus={setStatus}
              currentTimestamp={currentTimestamp}
            />
          )}

          {activeTab === 'aiAnalysis' && (
            <AiAnalysisTab
              settings={settings}
              setSettings={setSettings}
              setStatus={setStatus}
              currentTimestamp={currentTimestamp}
              aiModelLabel={aiModelLabel}
              setAiModelLabel={setAiModelLabel}
              aiModelProvider={aiModelProvider}
              setAiModelProvider={setAiModelProvider}
              aiModelName={aiModelName}
              setAiModelName={setAiModelName}
              aiModelBaseUrl={aiModelBaseUrl}
              setAiModelBaseUrl={setAiModelBaseUrl}
              aiKeyProvider={aiKeyProvider}
              setAiKeyProvider={setAiKeyProvider}
              aiKeyValue={aiKeyValue}
              setAiKeyValue={setAiKeyValue}
              aiKeyRotating={aiKeyRotating}
              canManageAi={canManageAi}
              canUseAi={canUseAi}
              defaultModelNameForAiProvider={defaultModelNameForAiProvider}
              defaultBaseUrlForAiProvider={defaultBaseUrlForAiProvider}
              addAiModel={addAiModel}
              updateAiModel={updateAiModel}
              deleteAiModel={deleteAiModel}
              rotateAiProviderKey={rotateAiProviderKey}
            />
          )}

          {activeTab === 'usersRoles' && canManageUsers && (
            <UsersRolesTab
              canManageRoles={canManageRoles}
              setStatus={setStatus}
              showAlert={showAlert}
            />
          )}

          {activeTab === 'seasonRepair' && (
            <SeasonRepairTab
              running={seasonRepairRunning}
              status={seasonRepairStatus}
              selectedSeasonId={selectedSeasonId}
              onImport={handleSeasonRepairImport}
            />
          )}

          {activeTab === 'updates' && <UpdatesTab />}
        </main>
      </div>
      {dialogNode}
    </div>
  );
}
