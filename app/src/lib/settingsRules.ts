import type {
  AircraftGroup,
  AirlineColorSetting,
  CheckInCounterGroup,
  CheckInCounterLock,
  CheckInCounterResource,
  CounterAllocationRule,
  CounterRuleConditions,
  DashboardAlertSettings,
  FlightRecord,
  GateGroup,
  GateLock,
  GateResource,
  OperationalSettings,
  RouteCountryMapping,
  StandGateMapping,
} from './types';
import { normalizeStandValue } from './operationalResourceValues.ts';
import { listRouteCountries, normalizeRouteCode } from './routeCountry.ts';

type SettingsInput = (Partial<Omit<OperationalSettings, 'dashboardAlerts'>> & {
  dashboardAlerts?: Partial<DashboardAlertSettings> | null;
}) | null | undefined;
type RuleMatch = {
  rule: CounterAllocationRule;
  counterValue: number;
  specificity: number;
};

const EMPTY_CONDITIONS: CounterRuleConditions = {
  aircraftTypes: [],
  aircraftGroups: [],
  airlineCodes: [],
};


export const DEFAULT_DASHBOARD_ALERT_SETTINGS: DashboardAlertSettings = {
  arrivalBucketFlights: null,
  departureBucketFlights: null,
  adGapFlights: null,
  ctgAbsPct: null,
  paxCoverageMinPct: null,
};

export const DEFAULT_AIRLINE_COLORS: AirlineColorSetting[] = [
  { airlineCode: 'VJ', color: '#ED1B24' },
  { airlineCode: 'VN', color: '#004B87' },
  { airlineCode: 'AK', color: '#E31226' },
  { airlineCode: 'UO', color: '#5C2D91' },
  { airlineCode: 'FD', color: '#E31226' },
  { airlineCode: 'VZ', color: '#ED1B24' },
  { airlineCode: 'TW', color: '#D22C2A' },
  { airlineCode: 'SQ', color: '#00266B' },
  { airlineCode: 'NX', color: '#E31837' },
  { airlineCode: 'KE', color: '#0064B0' },
  { airlineCode: 'BX', color: '#004F9F' },
  { airlineCode: 'HX', color: '#E4002B' },
  { airlineCode: 'LJ', color: '#A6CE39' },
  { airlineCode: '7C', color: '#FF5000' },
  { airlineCode: 'IT', color: '#F5D000' },
  { airlineCode: '5J', color: '#F7A11A' },
  { airlineCode: 'K6', color: '#4A235A' },
  { airlineCode: 'QH', color: '#78B943' },
  { airlineCode: 'BR', color: '#007A53' },
  { airlineCode: 'TR', color: '#FFE800' },
  { airlineCode: 'OZ', color: '#D6081A' },
  { airlineCode: 'WE', color: '#00A3E0' },
  { airlineCode: 'PR', color: '#0038A8' },
  { airlineCode: 'CI', color: '#BE3A6B' },
  { airlineCode: 'MH', color: '#003152' },
  { airlineCode: 'OD', color: '#E3000F' },
  { airlineCode: 'JX', color: '#B48C5B' },
  { airlineCode: 'RS', color: '#00C2A7' },
  { airlineCode: 'Z2', color: '#E31226' },
  { airlineCode: 'ZE', color: '#ED1B24' },
  { airlineCode: 'RF', color: '#FFD100' },
  { airlineCode: 'EK', color: '#D71A21' },
  { airlineCode: 'YP', color: '#0B1E4A' },
  { airlineCode: '8M', color: '#1D3B78' },
  { airlineCode: 'QZ', color: '#E31226' },
  { airlineCode: 'KC', color: '#009FA8' },
  { airlineCode: 'QV', color: '#003C71' },
];

export const DEFAULT_GATE_RESOURCES: GateResource[] = Array.from({ length: 10 }, (_, index) => {
  const gate = index + 1;
  return {
    id: `GATE_${gate}`,
    label: String(gate),
    enabled: true,
    sortOrder: gate,
    createdAt: 0,
    updatedAt: 0,
  };
});

export const DEFAULT_GATE_GROUPS: GateGroup[] = [
  {
    id: 'GATE_GROUP_1_3',
    name: 'Gate 1-3',
    gateIds: ['GATE_1', 'GATE_2', 'GATE_3'],
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'GATE_GROUP_PBB',
    name: 'Gate PBB',
    gateIds: ['GATE_4', 'GATE_5', 'GATE_6', 'GATE_7'],
    sortOrder: 2,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'GATE_GROUP_8_10',
    name: 'Gate 8-10',
    gateIds: ['GATE_8', 'GATE_9', 'GATE_10'],
    sortOrder: 3,
    createdAt: 0,
    updatedAt: 0,
  },
];

export const DEFAULT_STAND_GATE_MAPPINGS: StandGateMapping[] = [
  { id: 'STAND_14_GATE_7', stand: '14', gate: 7, sortOrder: 1, enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'STAND_16_GATE_6', stand: '16', gate: 6, sortOrder: 2, enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'STAND_18_GATE_5', stand: '18', gate: 5, sortOrder: 3, enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'STAND_20_GATE_4', stand: '20', gate: 4, sortOrder: 4, enabled: true, createdAt: 0, updatedAt: 0 },
];

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeUniqueCodes(values: unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const code = normalizeCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function normalizeHexColor(value: unknown): string {
  const color = String(value ?? '').trim().toUpperCase();
  const prefixed = color.startsWith('#') ? color : `#${color}`;
  return prefixed;
}

function normalizeNullableNumber(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDashboardAlerts(settings: Partial<DashboardAlertSettings> | null | undefined): DashboardAlertSettings {
  return {
    arrivalBucketFlights: normalizeNullableNumber(settings?.arrivalBucketFlights, 1, 999),
    departureBucketFlights: normalizeNullableNumber(settings?.departureBucketFlights, 1, 999),
    adGapFlights: normalizeNullableNumber(settings?.adGapFlights, 1, 999),
    ctgAbsPct: normalizeNullableNumber(settings?.ctgAbsPct, 0, 10),
    paxCoverageMinPct: normalizeNullableNumber(settings?.paxCoverageMinPct, 0, 1),
  };
}

function normalizeUniqueIds(values: unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const id = String(value ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function normalizeConditions(conditions: Partial<CounterRuleConditions> | undefined): CounterRuleConditions {
  return {
    aircraftTypes: normalizeUniqueCodes(conditions?.aircraftTypes),
    aircraftGroups: normalizeUniqueIds(conditions?.aircraftGroups),
    airlineCodes: normalizeUniqueCodes(conditions?.airlineCodes),
  };
}

function hasCondition(conditions: CounterRuleConditions): boolean {
  return conditions.aircraftTypes.length > 0 || conditions.aircraftGroups.length > 0 || conditions.airlineCodes.length > 0;
}

function specificity(conditions: CounterRuleConditions): number {
  return [
    conditions.aircraftTypes.length > 0,
    conditions.aircraftGroups.length > 0,
    conditions.airlineCodes.length > 0,
  ].filter(Boolean).length;
}

function normalizeGroup(group: Partial<AircraftGroup>): AircraftGroup {
  return {
    id: String(group.id ?? '').trim(),
    name: normalizeName(group.name),
    aircraftTypes: normalizeUniqueCodes(group.aircraftTypes),
    createdAt: Number(group.createdAt ?? 0),
    updatedAt: Number(group.updatedAt ?? group.createdAt ?? 0),
  };
}

function normalizeRule(rule: Partial<CounterAllocationRule>): CounterAllocationRule {
  return {
    id: String(rule.id ?? '').trim(),
    name: normalizeName(rule.name),
    enabled: Boolean(rule.enabled),
    priorityScore: Number(rule.priorityScore ?? 0),
    sortOrder: Number(rule.sortOrder ?? 0),
    conditions: normalizeConditions(rule.conditions),
    counterValue: Number(rule.counterValue ?? 0),
    createdAt: Number(rule.createdAt ?? 0),
    updatedAt: Number(rule.updatedAt ?? rule.createdAt ?? 0),
  };
}

function normalizeCounterResource(counter: Partial<CheckInCounterResource>): CheckInCounterResource {
  return {
    id: String(counter.id ?? '').trim(),
    label: normalizeName(counter.label),
    enabled: Boolean(counter.enabled),
    sortOrder: Number(counter.sortOrder ?? 0),
    createdAt: Number(counter.createdAt ?? 0),
    updatedAt: Number(counter.updatedAt ?? counter.createdAt ?? 0),
  };
}

function normalizeCounterGroup(group: Partial<CheckInCounterGroup>): CheckInCounterGroup {
  return {
    id: String(group.id ?? '').trim(),
    name: normalizeName(group.name),
    bhs: normalizeName(group.bhs),
    counterIds: normalizeUniqueIds(group.counterIds),
    sortOrder: Number(group.sortOrder ?? 0),
    createdAt: Number(group.createdAt ?? 0),
    updatedAt: Number(group.updatedAt ?? group.createdAt ?? 0),
  };
}

function normalizeCounterLock(lock: Partial<CheckInCounterLock>): CheckInCounterLock {
  return {
    id: String(lock.id ?? '').trim(),
    name: normalizeName(lock.name),
    counterIds: normalizeUniqueIds(lock.counterIds),
    start: String(lock.start ?? '').trim(),
    end: String(lock.end ?? '').trim(),
    reason: lock.reason == null ? null : normalizeName(lock.reason),
    enabled: Boolean(lock.enabled),
    createdAt: Number(lock.createdAt ?? 0),
    updatedAt: Number(lock.updatedAt ?? lock.createdAt ?? 0),
  };
}

function normalizeGateResource(gate: Partial<GateResource>): GateResource {
  return {
    id: String(gate.id ?? '').trim(),
    label: normalizeName(gate.label),
    enabled: Boolean(gate.enabled),
    sortOrder: Number(gate.sortOrder ?? 0),
    createdAt: Number(gate.createdAt ?? 0),
    updatedAt: Number(gate.updatedAt ?? gate.createdAt ?? 0),
  };
}

function normalizeGateGroup(group: Partial<GateGroup>): GateGroup {
  return {
    id: String(group.id ?? '').trim(),
    name: normalizeName(group.name),
    gateIds: normalizeUniqueIds(group.gateIds),
    sortOrder: Number(group.sortOrder ?? 0),
    createdAt: Number(group.createdAt ?? 0),
    updatedAt: Number(group.updatedAt ?? group.createdAt ?? 0),
  };
}

function normalizeGateLock(lock: Partial<GateLock>): GateLock {
  return {
    id: String(lock.id ?? '').trim(),
    name: normalizeName(lock.name),
    gateIds: normalizeUniqueIds(lock.gateIds),
    start: String(lock.start ?? '').trim(),
    end: String(lock.end ?? '').trim(),
    reason: lock.reason == null ? null : normalizeName(lock.reason),
    enabled: Boolean(lock.enabled),
    createdAt: Number(lock.createdAt ?? 0),
    updatedAt: Number(lock.updatedAt ?? lock.createdAt ?? 0),
  };
}

function normalizePositiveInteger(value: unknown): number {
  return Number(value ?? 0);
}

function normalizeStandGateMapping(mapping: Partial<StandGateMapping>): StandGateMapping {
  return {
    id: String(mapping.id ?? '').trim(),
    stand: normalizeStandValue(mapping.stand) ?? '',
    gate: normalizePositiveInteger(mapping.gate),
    sortOrder: Number(mapping.sortOrder ?? 0),
    enabled: Boolean(mapping.enabled),
    createdAt: Number(mapping.createdAt ?? 0),
    updatedAt: Number(mapping.updatedAt ?? mapping.createdAt ?? 0),
  };
}

function normalizeAirlineColor(setting: Partial<AirlineColorSetting>): AirlineColorSetting {
  return {
    airlineCode: normalizeCode(setting.airlineCode),
    color: normalizeHexColor(setting.color),
  };
}

function normalizeRouteCountry(setting: Partial<RouteCountryMapping>): RouteCountryMapping {
  return {
    route: normalizeRouteCode(setting.route),
    country: normalizeName(setting.country),
  };
}

function parseSettingsDateTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date.getTime();
}

export function hydrateOperationalSettings(settings: SettingsInput): OperationalSettings {
  return validateOperationalSettings({
    airlineColors: settings?.airlineColors ?? DEFAULT_AIRLINE_COLORS,
    routeCountries: settings?.routeCountries ?? listRouteCountries(),
    dashboardAlerts: settings?.dashboardAlerts ?? DEFAULT_DASHBOARD_ALERT_SETTINGS,
    aircraftGroups: settings?.aircraftGroups ?? [],
    counterAllocationRules: settings?.counterAllocationRules ?? [],
    checkInCounters: settings?.checkInCounters ?? [],
    checkInCounterGroups: settings?.checkInCounterGroups ?? [],
    checkInCounterLocks: settings?.checkInCounterLocks ?? [],
    gateResources: settings?.gateResources ?? DEFAULT_GATE_RESOURCES,
    gateGroups: settings?.gateGroups ?? DEFAULT_GATE_GROUPS,
    gateLocks: settings?.gateLocks ?? [],
    standGateMappings: settings?.standGateMappings ?? DEFAULT_STAND_GATE_MAPPINGS,
    updatedAt: settings?.updatedAt ?? null,
  });
}

export function validateOperationalSettings(settings: SettingsInput): OperationalSettings {
  const airlineColors = (settings?.airlineColors ?? []).map((setting) => normalizeAirlineColor(setting));
  const routeCountries = (settings?.routeCountries ?? []).map((setting) => normalizeRouteCountry(setting));
  const dashboardAlerts = normalizeDashboardAlerts(settings?.dashboardAlerts);
  const groups = (settings?.aircraftGroups ?? []).map((group) => normalizeGroup(group));
  const rules = (settings?.counterAllocationRules ?? []).map((rule) => normalizeRule(rule));
  const counters = (settings?.checkInCounters ?? []).map((counter) => normalizeCounterResource(counter));
  const counterGroups = (settings?.checkInCounterGroups ?? []).map((group) => normalizeCounterGroup(group));
  const counterLocks = (settings?.checkInCounterLocks ?? []).map((lock) => normalizeCounterLock(lock));
  const gates = (settings?.gateResources ?? []).map((gate) => normalizeGateResource(gate));
  const gateGroups = (settings?.gateGroups ?? []).map((group) => normalizeGateGroup(group));
  const gateLocks = (settings?.gateLocks ?? []).map((lock) => normalizeGateLock(lock));
  const standGateMappings = (settings?.standGateMappings ?? []).map((mapping) => normalizeStandGateMapping(mapping));
  const groupNameKeys = new Set<string>();
  const airlineColorCodes = new Set<string>();
  const routeCountryCodes = new Set<string>();
  const groupIds = new Set<string>();
  const aircraftOwners = new Map<string, string>();

  for (const setting of airlineColors) {
    if (!setting.airlineCode) throw new Error('Airline color code is required.');
    if (airlineColorCodes.has(setting.airlineCode)) throw new Error(`Duplicate airline color code ${setting.airlineCode}.`);
    airlineColorCodes.add(setting.airlineCode);
    if (!/^#[0-9A-F]{6}$/.test(setting.color)) {
      throw new Error(`Airline color ${setting.airlineCode} must use #RRGGBB.`);
    }
  }

  for (const setting of routeCountries) {
    if (!setting.route) throw new Error('Route-country route is required.');
    if (!setting.country) throw new Error(`Country is required for route ${setting.route}.`);
    if (routeCountryCodes.has(setting.route)) throw new Error(`Duplicate route-country route ${setting.route}.`);
    routeCountryCodes.add(setting.route);
  }

  for (const group of groups) {
    if (!group.id) throw new Error('A/C group id is required.');
    if (!group.name) throw new Error('A/C group name is required.');
    if (!Number.isFinite(group.createdAt) || !Number.isFinite(group.updatedAt)) {
      throw new Error(`A/C group ${group.name} timestamps must be finite numbers.`);
    }
    const nameKey = group.name.toLowerCase();
    if (groupNameKeys.has(nameKey)) throw new Error('Group names must be unique.');
    groupNameKeys.add(nameKey);
    if (groupIds.has(group.id)) throw new Error(`Duplicate A/C group id ${group.id}.`);
    groupIds.add(group.id);
    for (const aircraftType of group.aircraftTypes) {
      const previousGroup = aircraftOwners.get(aircraftType);
      if (previousGroup && previousGroup !== group.id) {
        throw new Error(`Aircraft type ${aircraftType} may belong to only one A/C group.`);
      }
      aircraftOwners.set(aircraftType, group.id);
    }
  }

  const ruleIds = new Set<string>();
  for (const rule of rules) {
    if (!rule.id) throw new Error('Counter rule id is required.');
    if (!rule.name) throw new Error('Counter rule name is required.');
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate counter rule id ${rule.id}.`);
    ruleIds.add(rule.id);
    if (typeof rule.enabled !== 'boolean') throw new Error(`Counter rule ${rule.name} must be explicitly enabled or disabled.`);
    if (!Number.isFinite(rule.priorityScore)) throw new Error(`Counter rule ${rule.name} priorityScore must be a finite number.`);
    if (!Number.isFinite(rule.sortOrder)) throw new Error(`Counter rule ${rule.name} sortOrder must be a finite number.`);
    if (!Number.isFinite(rule.createdAt) || !Number.isFinite(rule.updatedAt)) {
      throw new Error(`Counter rule ${rule.name} timestamps must be finite numbers.`);
    }
    if (rule.enabled && !hasCondition(rule.conditions)) throw new Error(`Counter rule ${rule.name} must have at least one condition.`);
    if (!Number.isInteger(rule.counterValue) || rule.counterValue <= 0) {
      throw new Error(`Counter rule ${rule.name} counterValue must be a positive integer.`);
    }
    for (const groupId of rule.conditions.aircraftGroups) {
      if (!groupIds.has(groupId)) throw new Error(`Counter rule ${rule.name} references missing A/C group ${groupId}.`);
    }
  }

  const counterIds = new Set<string>();
  const counterLabelKeys = new Set<string>();
  for (const counter of counters) {
    if (!counter.id) throw new Error('Counter id is required.');
    if (counterIds.has(counter.id)) throw new Error(`Duplicate counter id ${counter.id}.`);
    counterIds.add(counter.id);
    if (!counter.label) throw new Error('Counter label is required.');
    const labelKey = counter.label.toLowerCase();
    if (counterLabelKeys.has(labelKey)) throw new Error('Counter labels must be unique.');
    counterLabelKeys.add(labelKey);
    if (!Number.isFinite(counter.sortOrder) || !Number.isFinite(counter.createdAt) || !Number.isFinite(counter.updatedAt)) {
      throw new Error(`Counter ${counter.label} numeric metadata must be finite numbers.`);
    }
  }

  const counterGroupIds = new Set<string>();
  const counterGroupNameKeys = new Set<string>();
  const counterOwners = new Map<string, string>();
  for (const group of counterGroups) {
    if (!group.id) throw new Error('Counter group id is required.');
    if (counterGroupIds.has(group.id)) throw new Error(`Duplicate counter group id ${group.id}.`);
    counterGroupIds.add(group.id);
    if (!group.name) throw new Error('Counter group name is required.');
    const nameKey = group.name.toLowerCase();
    if (counterGroupNameKeys.has(nameKey)) throw new Error('Counter group names must be unique.');
    counterGroupNameKeys.add(nameKey);
    if (!Number.isFinite(group.sortOrder) || !Number.isFinite(group.createdAt) || !Number.isFinite(group.updatedAt)) {
      throw new Error(`Counter group ${group.name} numeric metadata must be finite numbers.`);
    }
    for (const counterId of group.counterIds) {
      if (!counterIds.has(counterId)) throw new Error(`Counter group ${group.name} references missing counter ${counterId}.`);
      const previousGroup = counterOwners.get(counterId);
      if (previousGroup && previousGroup !== group.id) {
        throw new Error(`Counter ${counterId} may belong to only one counter group.`);
      }
      counterOwners.set(counterId, group.id);
    }
  }

  const counterLockIds = new Set<string>();
  for (const lock of counterLocks) {
    if (!lock.id) throw new Error('Counter lock id is required.');
    if (counterLockIds.has(lock.id)) throw new Error(`Duplicate counter lock id ${lock.id}.`);
    counterLockIds.add(lock.id);
    if (!lock.name) throw new Error('Counter lock name is required.');
    if (!Number.isFinite(lock.createdAt) || !Number.isFinite(lock.updatedAt)) {
      throw new Error(`Counter lock ${lock.name} timestamps must be finite numbers.`);
    }
    for (const counterId of lock.counterIds) {
      if (!counterIds.has(counterId)) throw new Error(`Counter lock ${lock.name} references missing counter ${counterId}.`);
    }
    if (lock.enabled) {
      const start = parseSettingsDateTime(lock.start);
      const end = parseSettingsDateTime(lock.end);
      if (start == null || end == null) {
        throw new Error(`Counter lock ${lock.name} windows must use yyyy-mm-ddTHH:mm.`);
      }
      if (start >= end) throw new Error(`Counter lock ${lock.name} lock start must be before end.`);
    }
  }

  const gateIds = new Set<string>();
  const gateLabels = new Set<string>();
  const gateNumbers = new Set<number>();
  for (const gate of gates) {
    if (!gate.id) throw new Error('Gate id is required.');
    if (gateIds.has(gate.id)) throw new Error(`Duplicate gate id ${gate.id}.`);
    gateIds.add(gate.id);
    if (!gate.label) throw new Error('Gate label is required.');
    const labelKey = gate.label.toLowerCase();
    if (gateLabels.has(labelKey)) throw new Error('Gate labels must be unique.');
    gateLabels.add(labelKey);
    const gateNumber = Number(gate.label);
    if (!Number.isInteger(gateNumber) || gateNumber <= 0) throw new Error(`Gate ${gate.label} label must be a positive integer.`);
    gateNumbers.add(gateNumber);
    if (!Number.isFinite(gate.sortOrder) || !Number.isFinite(gate.createdAt) || !Number.isFinite(gate.updatedAt)) {
      throw new Error(`Gate ${gate.label} numeric metadata must be finite numbers.`);
    }
  }

  const gateGroupIds = new Set<string>();
  const gateGroupNames = new Set<string>();
  const gateOwners = new Map<string, string>();
  for (const group of gateGroups) {
    if (!group.id) throw new Error('Gate group id is required.');
    if (gateGroupIds.has(group.id)) throw new Error(`Duplicate gate group id ${group.id}.`);
    gateGroupIds.add(group.id);
    if (!group.name) throw new Error('Gate group name is required.');
    const nameKey = group.name.toLowerCase();
    if (gateGroupNames.has(nameKey)) throw new Error('Gate group names must be unique.');
    gateGroupNames.add(nameKey);
    if (!Number.isFinite(group.sortOrder) || !Number.isFinite(group.createdAt) || !Number.isFinite(group.updatedAt)) {
      throw new Error(`Gate group ${group.name} numeric metadata must be finite numbers.`);
    }
    for (const gateId of group.gateIds) {
      if (!gateIds.has(gateId)) throw new Error(`Gate group ${group.name} references missing gate ${gateId}.`);
      const previousGroup = gateOwners.get(gateId);
      if (previousGroup && previousGroup !== group.id) throw new Error(`Gate ${gateId} may belong to only one gate group.`);
      gateOwners.set(gateId, group.id);
    }
  }

  const gateLockIds = new Set<string>();
  for (const lock of gateLocks) {
    if (!lock.id) throw new Error('Gate lock id is required.');
    if (gateLockIds.has(lock.id)) throw new Error(`Duplicate gate lock id ${lock.id}.`);
    gateLockIds.add(lock.id);
    if (!lock.name) throw new Error('Gate lock name is required.');
    if (!Number.isFinite(lock.createdAt) || !Number.isFinite(lock.updatedAt)) {
      throw new Error(`Gate lock ${lock.name} timestamps must be finite numbers.`);
    }
    for (const gateId of lock.gateIds) {
      if (!gateIds.has(gateId)) throw new Error(`Gate lock ${lock.name} references missing gate ${gateId}.`);
    }
    if (lock.enabled) {
      const start = parseSettingsDateTime(lock.start);
      const end = parseSettingsDateTime(lock.end);
      if (start == null || end == null) {
        throw new Error(`Gate lock ${lock.name} windows must use yyyy-mm-ddTHH:mm.`);
      }
      if (start >= end) throw new Error(`Gate lock ${lock.name} lock start must be before end.`);
    }
  }

  const mappingIds = new Set<string>();
  const mappingStands = new Set<string>();
  for (const mapping of standGateMappings) {
    if (!mapping.id) throw new Error('Stand-gate mapping id is required.');
    if (mappingIds.has(mapping.id)) throw new Error(`Duplicate stand-gate mapping id ${mapping.id}.`);
    mappingIds.add(mapping.id);
    if (!normalizeStandValue(mapping.stand)) throw new Error(`Stand-gate mapping ${mapping.id} stand is required.`);
    if (!Number.isInteger(mapping.gate) || mapping.gate <= 0) throw new Error(`Stand-gate mapping ${mapping.id} gate must be a positive integer.`);
    if (mapping.enabled && mappingStands.has(mapping.stand)) throw new Error(`Stand ${mapping.stand} may map to only one enabled gate.`);
    if (mapping.enabled) mappingStands.add(mapping.stand);
    if (mapping.enabled && !gateNumbers.has(mapping.gate)) throw new Error(`Stand ${mapping.stand} maps to missing gate ${mapping.gate}.`);
    if (!Number.isFinite(mapping.sortOrder) || !Number.isFinite(mapping.createdAt) || !Number.isFinite(mapping.updatedAt)) {
      throw new Error(`Stand-gate mapping ${mapping.id} numeric metadata must be finite numbers.`);
    }
  }

  return {
    airlineColors,
    routeCountries,
    dashboardAlerts,
    aircraftGroups: groups,
    counterAllocationRules: rules,
    checkInCounters: counters,
    checkInCounterGroups: counterGroups,
    checkInCounterLocks: counterLocks,
    gateResources: gates,
    gateGroups,
    gateLocks,
    standGateMappings,
    updatedAt: settings?.updatedAt == null ? null : Number(settings.updatedAt),
  };
}

function matchesAny(actual: string, expected: string[]): boolean {
  return expected.length === 0 || expected.includes(actual);
}

function recordMatchesGroup(recordAircraft: string, groupIds: string[], groups: AircraftGroup[]): boolean {
  if (groupIds.length === 0) return true;
  return groups.some((group) => groupIds.includes(group.id) && group.aircraftTypes.includes(recordAircraft));
}

function ruleMatches(record: Pick<FlightRecord, 'aircraft' | 'airline'>, rule: CounterAllocationRule, groups: AircraftGroup[]): boolean {
  const aircraft = normalizeCode(record.aircraft);
  const airline = normalizeCode(record.airline);
  return matchesAny(aircraft, rule.conditions.aircraftTypes) &&
    recordMatchesGroup(aircraft, rule.conditions.aircraftGroups, groups) &&
    matchesAny(airline, rule.conditions.airlineCodes);
}

function compareMatches(left: RuleMatch, right: RuleMatch): number {
  return right.rule.priorityScore - left.rule.priorityScore ||
    right.specificity - left.specificity ||
    left.rule.sortOrder - right.rule.sortOrder ||
    left.rule.createdAt - right.rule.createdAt ||
    left.rule.id.localeCompare(right.rule.id);
}

export function evaluateCounterRules(
  record: Pick<FlightRecord, 'aircraft' | 'airline'>,
  settings: OperationalSettings
): { rule: CounterAllocationRule | null; counterValue: number | null } {
  const normalized = validateOperationalSettings(settings);
  const matches = normalized.counterAllocationRules
    .filter((rule) => rule.enabled && ruleMatches(record, rule, normalized.aircraftGroups))
    .map((rule) => ({
      rule,
      counterValue: rule.counterValue,
      specificity: specificity(rule.conditions),
    }))
    .sort(compareMatches);

  const winner = matches[0] ?? null;
  return {
    rule: winner?.rule ?? null,
    counterValue: winner?.counterValue ?? null,
  };
}

export function removeAircraftGroupFromSettings(
  settings: OperationalSettings,
  groupId: string,
  updatedAt: number
): OperationalSettings {
  const normalized = validateOperationalSettings(settings);
  const nextRules = normalized.counterAllocationRules.map((rule) => {
    const conditions = {
      ...rule.conditions,
      aircraftGroups: rule.conditions.aircraftGroups.filter((id) => id !== groupId),
    };
    const isEmpty = !hasCondition(conditions);
    return {
      ...rule,
      enabled: isEmpty ? false : rule.enabled,
      conditions: isEmpty ? { ...EMPTY_CONDITIONS } : conditions,
      updatedAt,
    };
  });

  return validateOperationalSettings({
    aircraftGroups: normalized.aircraftGroups.filter((group) => group.id !== groupId),
    counterAllocationRules: nextRules,
    checkInCounters: normalized.checkInCounters,
    checkInCounterGroups: normalized.checkInCounterGroups,
    checkInCounterLocks: normalized.checkInCounterLocks,
    gateResources: normalized.gateResources,
    gateGroups: normalized.gateGroups,
    gateLocks: normalized.gateLocks,
    standGateMappings: normalized.standGateMappings,
    airlineColors: normalized.airlineColors,
    routeCountries: normalized.routeCountries,
    dashboardAlerts: normalized.dashboardAlerts,
    updatedAt,
  });
}
