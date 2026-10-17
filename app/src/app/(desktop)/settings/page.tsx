'use client';
import { formatUiError } from '@/lib/uiDisplayText';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { getCurrentOperatorAccess } from '@/lib/operatorUserManagement';
import {
  saveOperationalSettings,
} from '@/lib/remoteStore';
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
import { hydrateOperationalSettings, removeAircraftGroupFromSettings, validateOperationalSettings } from '@/lib/settingsRules';
import { appendAuditLogEntry, buildSettingsAuditDeltas } from '@/lib/auditLog';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { resolveSettingsProtectedTab, type SettingsTab } from '@/lib/settingsAccessState';
import {
  commitOperationalSettingsSnapshot,
  readOperationalSettingsState,
  revalidateOperationalSettings,
} from '@/lib/operationalSettingsReadModel';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from '@/lib/operatorSessionCacheRegistry';
import type {
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
  StandGateMapping,
} from '@/lib/types';
import { useAppDialog } from '../components/AppDialog';
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
import DashboardAlertsTab from './components/DashboardAlertsTab';
import UpdatesTab from './components/UpdatesTab';
import UsersRolesTab from './components/UsersRolesTab';

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
    left.sortOrder - right.sortOrder || left.stand.localeCompare(right.stand, undefined, { numeric: true }) || left.gate - right.gate
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
  if (rule.conditions.aircraftTypes.length > 0) parts.push(`Tàu bay: ${joinCodes(rule.conditions.aircraftTypes)}`);
  if (rule.conditions.airlineCodes.length > 0) parts.push(`Hãng: ${joinCodes(rule.conditions.airlineCodes)}`);
  if (rule.conditions.aircraftGroups.length > 0) {
    const names = rule.conditions.aircraftGroups.map((id) => settings.aircraftGroups.find((group) => group.id === id)?.name ?? id);
    parts.push(`Nhóm tàu bay: ${names.join(', ')}`);
  }
  return parts.join(' | ') || 'Không có điều kiện';
}

export default function SettingsPage() {
  const initialSettingsState = readOperationalSettingsState();
  const { dialogNode, showAlert, showConfirm } = useAppDialog();
  const [activeTab, setActiveTab] = useSessionState<SettingsTab>('settings:activeTab', 'checkinCounters');
  const [settings, setSettings] = useState<OperationalSettings>(() => initialSettingsState.snapshot ?? emptySettings());
  const [savedSettings, setSavedSettings] = useState<OperationalSettings>(() => initialSettingsState.snapshot ?? emptySettings());
  const [loading, setLoading] = useState(initialSettingsState.snapshot === null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Đang tải cài đặt...', 20, 'Đang chuẩn bị cài đặt vận hành')
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
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [accessLoading, setAccessLoading] = useState(true);
  const [routeCountryRoute, setRouteCountryRoute] = useState('');
  const [routeCountryCountry, setRouteCountryCountry] = useState('');
  const [routeCountrySearch, setRouteCountrySearch] = useState('');
  const [routeCountryImportStatus, setRouteCountryImportStatus] = useState<string | null>(null);
  const settingsScrollRef = useRef<HTMLElement | null>(null);
  useSessionScrollRestoration('settings:scroll', settingsScrollRef);


  useEffect(() => {
    let cancelled = false;
    const operatorSessionEpoch = getOperatorSessionEpoch();
    const snapshotState = readOperationalSettingsState();
    (async () => {
      await Promise.resolve();
      if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      if (snapshotState.snapshot) {
        setSettings(snapshotState.snapshot);
        setSavedSettings(snapshotState.snapshot);
      }
      if (!snapshotState.shouldRevalidate) {
        setLoading(false);
        return;
      }
      try {
        setLoadProgress(buildLoadProgress('Đang tải cài đặt...', 45, 'Đang lấy cài đặt vận hành', { indeterminate: true }));
        const loaded = await revalidateOperationalSettings();
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
          setLoadProgress(buildLoadProgress('Đang hiển thị cài đặt...', 90, 'Đang áp dụng cấu hình đã lưu'));
          setSettings(loaded);
          setSavedSettings(loaded);
        }
      } catch (err) {
        if (cancelled || !isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
        if (snapshotState.snapshot) setStatus(`Làm mới cài đặt thất bại: ${formatUiError(err)}`);
        else void showAlert({ title: 'Tải cài đặt thất bại', message: formatUiError(err, 'Không thể tải cài đặt vận hành'), tone: 'error' });
      } finally {
        if (!cancelled && isOperatorSessionEpochCurrent(operatorSessionEpoch)) setLoading(false);
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
          setCanManageUsers(access.canManageUsers);
          setCanManageRoles(access.permissions.has('roles.manage'));
        }
      } catch {
        if (!cancelled) {
          setCanManageUsers(false);
          setCanManageRoles(false);
        }
      } finally {
        if (!cancelled) setAccessLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const resolved = resolveSettingsProtectedTab({
      activeTab,
      accessLoading,
      canManageUsers,
    });
    if (resolved !== activeTab) setActiveTab(resolved);
  }, [accessLoading, activeTab, canManageUsers, setActiveTab]);

  const visibleTabs = useMemo(() => [
    { id: 'checkinCounters' as const, label: 'Quầy' },
    { id: 'gateAllocation' as const, label: 'Cửa & Vị trí đỗ' },
    { id: 'locksAndOutages' as const, label: 'Khóa / Tạm dừng' },
    { id: 'groups' as const, label: 'Nhóm tàu bay' },
    { id: 'rules' as const, label: 'Quy tắc phân bổ' },
    { id: 'routeCountries' as const, label: 'Chặng - quốc gia' },
    { id: 'airlineColors' as const, label: 'Màu hãng bay' },
    { id: 'dashboardAlerts' as const, label: 'Cảnh báo tổng quan' },
    ...(canManageUsers ? [{ id: 'usersRoles' as const, label: 'Người dùng & Vai trò' }] : []),
    { id: 'updates' as const, label: 'Cập nhật' },
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
    const operatorSessionEpoch = getOperatorSessionEpoch();
    setSaving(true);
    setStatus(null);
    try {
      const savingSnapshotString = JSON.stringify(settings);
      const normalized = validateOperationalSettings({ ...settings, updatedAt: currentTimestamp() });
      await saveOperationalSettings(normalized, { operatorSessionEpoch });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      commitOperationalSettingsSnapshot(normalized, { operatorSessionEpoch });
      setSettings((current) => resolveSettingsAfterSave(current, savingSnapshotString, normalized));
      setSavedSettings(normalized);
      await appendAuditLogEntry({
        seasonId: null,
        seasonCode: null,
        module: 'settings',
        category: 'settings',
        operation: 'Saved operational settings',
        targetFlightIds: [],
        targetFlightLabels: [],
        deltas: buildSettingsAuditDeltas(savedSettings, normalized),
      }, { operatorSessionEpoch });
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      setStatus('Đã lưu cài đặt');
    } catch (err) {
      if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
      void showAlert({ title: 'Lưu cài đặt thất bại', message: formatUiError(err, 'Không thể lưu cài đặt vận hành'), tone: 'error' });
    } finally {
      if (isOperatorSessionEpochCurrent(operatorSessionEpoch)) setSaving(false);
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
    setStatus('Đã thêm nhóm tàu bay (chưa lưu)');
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
    setStatus('Đã đổi nhóm tàu bay (chưa lưu)');
  };

  const deleteGroup = async (id: string) => {
    const group = settings.aircraftGroups.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa nhóm tàu bay',
      message: `Xóa nhóm ${group?.name ?? 'này'}? Các quy tắc chỉ dùng nhóm này sẽ bị tắt.`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    try {
      setSettings((current) => removeAircraftGroupFromSettings(current, id, currentTimestamp()));
      setStatus('Đã xóa nhóm tàu bay (chưa lưu)');
    } catch (err) {
      void showAlert({ title: 'Xóa thất bại', message: formatUiError(err, 'Không thể xóa nhóm tàu bay'), tone: 'error' });
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
    setStatus('Đã thêm quy tắc quầy (chưa lưu)');
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
    setStatus('Đã đổi quy tắc quầy (chưa lưu)');
  };

  const deleteRule = async (id: string) => {
    const rule = settings.counterAllocationRules.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa quy tắc quầy',
      message: `Xóa quy tắc ${rule?.name ?? 'này'}?`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      counterAllocationRules: current.counterAllocationRules.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Đã xóa quy tắc quầy (chưa lưu)');
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
      void showAlert({ title: 'Chưa thêm quầy', message: 'Vui lòng nhập ít nhất một nhãn quầy làm thủ tục mới.', tone: 'warning' });
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
    setStatus(`Đã thêm ${newLabels.length} quầy thủ tục (chưa lưu)`);
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
    setStatus('Đã đổi quầy thủ tục (chưa lưu)');
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
      void showAlert({ title: 'Yêu cầu nhãn quầy', message: 'Nhãn quầy thủ tục không được để trống.', tone: 'warning' });
      return;
    }
    const confirmed = await showConfirm({
      title: 'Đổi tên quầy',
      message: `Việc đổi nhãn quầy có thể ảnh hưởng đến nhóm, khóa và phân bổ hiện có. Đổi tên ${counter.label} thành ${normalizedLabel || 'trống'}?`,
      tone: 'warning',
      confirmLabel: 'Đổi tên',
    });
    if (!confirmed) {
      setCounterLabelDrafts((current) => ({ ...current, [counter.id]: counter.label }));
      return;
    }
    setSettings((current) => renameCheckInCounterLabelInSettings(current, counter.id, normalizedLabel, currentTimestamp()));
    setStatus('Đã đổi quầy thủ tục (chưa lưu)');
    setCounterLabelDrafts((current) => {
      const rest = { ...current };
      delete rest[counter.id];
      return rest;
    });
  };

  const deleteCheckInCounter = async (id: string) => {
    const counter = settings.checkInCounters.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa quầy',
      message: `Xóa quầy ${counter?.label ?? 'này'}? Quầy sẽ bị xóa khỏi các nhóm quầy và khóa quầy.`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    const now = currentTimestamp();
    setSettings((current) => deleteCheckInCounterFromSettings(current, id, now));
    setCounterGroupCounterIds((current) => current.filter((counterId) => counterId !== id));
    setLockCounterIds((current) => current.filter((counterId) => counterId !== id));
    setStatus('Đã xóa quầy thủ tục (chưa lưu)');
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
    setStatus('Đã thêm nhóm quầy (chưa lưu)');
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
    setStatus('Đã đổi nhóm quầy (chưa lưu)');
  };

  const toggleCheckInCounterGroupCounter = (groupId: string, counterId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleCheckInCounterGroupMembership(current, groupId, counterId, now));
    setStatus('Đã đổi thành viên nhóm quầy (chưa lưu)');
  };

  const deleteCheckInCounterGroup = async (id: string) => {
    const group = settings.checkInCounterGroups.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa nhóm quầy',
      message: `Xóa nhóm quầy ${group?.name ?? 'này'}? Danh sách quầy và các khóa quầy vẫn được giữ nguyên.`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      checkInCounterGroups: current.checkInCounterGroups.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Đã xóa nhóm quầy (chưa lưu)');
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
    setStatus('Đã thêm khóa quầy (chưa lưu)');
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
    setStatus('Đã đổi khóa quầy (chưa lưu)');
  };

  const toggleCheckInCounterLockCounter = (lock: CheckInCounterLock, counterId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleCheckInCounterLockMembership(current, lock.id, counterId, now));
    setStatus('Đã đổi khóa quầy (chưa lưu)');
  };

  const deleteCheckInCounterLock = async (id: string) => {
    const lock = settings.checkInCounterLocks.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa khóa quầy',
      message: `Xóa khóa quầy ${lock?.name ?? 'này'}?`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      checkInCounterLocks: current.checkInCounterLocks.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Đã xóa khóa quầy (chưa lưu)');
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
    setStatus('Đã đổi cửa (chưa lưu)');
  };

  const addGateResource = () => {
    const label = gateLabel.trim();
    if (!label) {
      void showAlert({ title: 'Chưa thêm cửa', message: 'Vui lòng nhập nhãn cửa trước khi thêm.', tone: 'warning' });
      return;
    }
    if (settings.gateResources.some((gate) => gate.label.trim().toLowerCase() === label.toLowerCase())) {
      void showAlert({ title: 'Chưa thêm cửa', message: `Cửa ${label} đã tồn tại.`, tone: 'warning' });
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
    setStatus(`Đã thêm cửa ${label} (chưa lưu)`);
  };

  const deleteGateResource = async (id: string) => {
    const gate = settings.gateResources.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa cửa',
      message: `Xóa cửa ${gate?.label ?? 'này'}? Cửa sẽ bị xóa khỏi các nhóm cửa và khóa cửa.`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    const now = currentTimestamp();
    setSettings((current) => deleteGateFromSettings(current, id, now));
    setGateGroupGateIds((current) => current.filter((gateId) => gateId !== id));
    setGateLockGateIds((current) => current.filter((gateId) => gateId !== id));
    setStatus('Đã xóa cửa (chưa lưu)');
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
    setStatus('Đã đổi nhóm cửa (chưa lưu)');
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
    setStatus('Đã thêm nhóm cửa (chưa lưu)');
  };

  const toggleGateGroupGate = (groupId: string, gateId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleGateGroupMembership(current, groupId, gateId, now));
    setStatus('Đã đổi thành viên nhóm cửa (chưa lưu)');
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
    setStatus('Đã thêm khóa cửa (chưa lưu)');
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
    setStatus('Đã đổi khóa cửa (chưa lưu)');
  };

  const toggleGateLockGate = (lock: GateLock, gateId: string) => {
    const now = currentTimestamp();
    setSettings((current) => toggleGateLockMembership(current, lock.id, gateId, now));
    setStatus('Đã đổi khóa cửa (chưa lưu)');
  };

  const deleteGateLock = async (id: string) => {
    const lock = settings.gateLocks.find((item) => item.id === id);
    const confirmed = await showConfirm({
      title: 'Xóa khóa cửa',
      message: `Xóa khóa cửa ${lock?.name ?? 'này'}?`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      gateLocks: current.gateLocks.filter((item) => item.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Đã xóa khóa cửa (chưa lưu)');
  };

  const addStandGateMapping = () => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      standGateMappings: [
        ...current.standGateMappings,
        {
          id: makeId('SGM'),
          stand: String(standMappingStand).trim().toUpperCase(),
          gate: Number(standMappingGate),
          sortOrder: nextSortOrder(current.standGateMappings),
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }));
    setStatus('Đã thêm liên kết vị trí đỗ - cửa (chưa lưu)');
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
    setStatus('Đã đổi liên kết vị trí đỗ - cửa (chưa lưu)');
  };

  const deleteStandGateMapping = (id: string) => {
    setSettings((current) => ({
      ...current,
      standGateMappings: current.standGateMappings.filter((mapping) => mapping.id !== id),
      updatedAt: currentTimestamp(),
    }));
    setStatus('Đã xóa liên kết vị trí đỗ - cửa (chưa lưu)');
  };

  const addOrUpdateRouteCountry = () => {
    const route = normalizeRouteCode(routeCountryRoute);
    const country = normalizeRouteCountryValue(routeCountryCountry);
    if (!route || !country) {
      void showAlert({ title: 'Lỗi Chặng - quốc gia', message: 'Cần nhập đầy đủ chặng bay và quốc gia.', tone: 'error' });
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
    setStatus('Đã đổi chặng - quốc gia (chưa lưu)');
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
    setStatus('Đã đổi chặng - quốc gia (chưa lưu)');
  };

  const deleteRouteCountry = async (route: string) => {
    const confirmed = await showConfirm({
      title: 'Xóa Chặng - quốc gia',
      message: `Xóa ánh xạ quốc gia cho chặng bay ${route}? Các dòng trên bảng tổng quan của chặng bay đó sẽ trở thành Không xác định sau khi lưu.`,
      tone: 'warning',
      confirmLabel: 'Xóa',
    });
    if (!confirmed) return;
    setSettings((current) => ({
      ...current,
      routeCountries: current.routeCountries.filter((item) => item.route !== route),
      updatedAt: currentTimestamp(),
    }));
    setRouteCountryImportStatus(null);
    setStatus('Đã xóa chặng - quốc gia (chưa lưu)');
  };

  const handleRouteCountryImport = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('Tệp nhập không chứa bảng tính hợp lệ.');
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' });
      const parsed = parseRouteCountryRows(rows);
      if (parsed.entries.length === 0) {
        throw new Error('Không tìm thấy dòng Chặng bay / Quốc gia hợp lệ nào trong tệp tải lên.');
      }
      const existingRoutes = new Set(settings.routeCountries.map((item) => normalizeRouteCode(item.route)));
      const updatedRoutes = parsed.entries.filter((entry) => existingRoutes.has(entry.route)).length;
      const addedRoutes = parsed.entries.length - updatedRoutes;
      const confirmed = await showConfirm({
        title: 'Cập nhật sơ đồ Chặng - quốc gia',
        message: `Cập nhật ${updatedRoutes} chặng bay hiện có và thêm ${addedRoutes} chặng bay mới từ ${file.name}? Các chặng bay không có trong tệp sẽ được giữ nguyên.`,
        tone: 'warning',
        confirmLabel: 'Cập nhật sơ đồ',
      });
      if (!confirmed) return;
      const now = currentTimestamp();
      setSettings((current) => ({
        ...current,
        routeCountries: mergeRouteCountryMappings(current.routeCountries, parsed.entries),
        updatedAt: now,
      }));
      const importNotes = [
        `${updatedRoutes} chặng bay được cập nhật`,
        `${addedRoutes} chặng bay được thêm mới`,
        parsed.duplicateRoutes.length > 0 ? `${parsed.duplicateRoutes.length} chặng bay trùng lặp được thay thế bằng dòng cuối` : null,
        parsed.invalidRows.length > 0 ? `${parsed.invalidRows.length} dòng không hợp lệ bị bỏ qua` : null,
      ].filter(Boolean).join(' | ');
      setRouteCountryImportStatus(importNotes);
      setStatus('Đã nhập chặng - quốc gia (chưa lưu)');
    } catch (err) {
      void showAlert({ title: 'Nhập Chặng - quốc gia thất bại', message: formatUiError(err, 'Không thể nhập tệp chặng - quốc gia'), tone: 'error' });
    }
  }, [settings.routeCountries, showAlert, showConfirm]);

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
    setStatus('Đã đổi màu hãng bay (chưa lưu)');
  };

  const addAirlineColor = () => {
    const code = normalizeAirlineColorCode(airlineColorCode);
    const color = normalizeAirlineColorValue(airlineColorValue);
    if (!code) {
      void showAlert({ title: 'Thêm màu hãng bay thất bại', message: 'Mã hãng hàng không là bắt buộc.', tone: 'error' });
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
    setStatus('Đã thêm màu hãng bay (chưa lưu)');
  };

  const deleteAirlineColor = (airlineCode: string) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      airlineColors: current.airlineColors.filter((item) => item.airlineCode !== airlineCode),
      updatedAt: now,
    }));
    setStatus('Đã xóa màu hãng bay (chưa lưu)');
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
            <h1 className="font-h3 text-h3 text-on-surface">Cài đặt</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Cấu hình vận hành hệ thống</p>
          </div>
          <div className="flex items-center gap-3">
            {status && <span className="text-sm text-on-surface-variant">{status}</span>}
            {isDirty && <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800"><span className="h-2 w-2 rounded-full bg-amber-500" />Thay đổi chưa lưu</span>}
            <button
              type="button"
              onClick={persistSettings}
              disabled={saving || !isDirty}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[18px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'progress_activity' : 'save'}</span>
              {saving ? 'Đang lưu' : 'Lưu cài đặt'}
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


          {activeTab === 'usersRoles' && canManageUsers && (
            <UsersRolesTab
              canManageRoles={canManageRoles}
              setStatus={setStatus}
              showAlert={showAlert}
            />
          )}


          {activeTab === 'updates' && <UpdatesTab />}
        </main>
      </div>
      {dialogNode}
    </div>
  );
}
