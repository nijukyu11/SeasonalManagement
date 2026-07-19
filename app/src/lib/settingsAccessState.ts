export type SettingsTab =
  | 'checkinCounters'
  | 'gateAllocation'
  | 'locksAndOutages'
  | 'groups'
  | 'rules'
  | 'routeCountries'
  | 'airlineColors'
  | 'dashboardAlerts'
  | 'aiAnalysis'
  | 'usersRoles'
  | 'seasonRepair'
  | 'updates';

export function resolveSettingsProtectedTab(input: {
  activeTab: SettingsTab;
  accessLoading: boolean;
  canRepairSeason: boolean;
  canManageUsers: boolean;
}): SettingsTab {
  if (input.accessLoading) return input.activeTab;
  if (input.activeTab === 'usersRoles' && !input.canManageUsers) return 'checkinCounters';
  if (input.activeTab === 'seasonRepair' && !input.canRepairSeason) return 'checkinCounters';
  return input.activeTab;
}
