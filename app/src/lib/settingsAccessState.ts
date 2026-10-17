export type SettingsTab =
  | 'checkinCounters'
  | 'gateAllocation'
  | 'locksAndOutages'
  | 'groups'
  | 'rules'
  | 'routeCountries'
  | 'airlineColors'
  | 'dashboardAlerts'
  | 'usersRoles'
  | 'updates';

const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  'checkinCounters',
  'gateAllocation',
  'locksAndOutages',
  'groups',
  'rules',
  'routeCountries',
  'airlineColors',
  'dashboardAlerts',
  'usersRoles',
  'updates',
];

export function isSettingsTab(tab: unknown): tab is SettingsTab {
  return typeof tab === 'string' && (VALID_SETTINGS_TABS as readonly string[]).includes(tab);
}

export function resolveSettingsProtectedTab(input: {
  activeTab: SettingsTab | string;
  accessLoading: boolean;
  canManageUsers: boolean;
}): SettingsTab {
  if (!isSettingsTab(input.activeTab)) return 'checkinCounters';
  if (input.accessLoading) return input.activeTab;
  if (input.activeTab === 'usersRoles' && !input.canManageUsers) return 'checkinCounters';
  return input.activeTab;
}
