export const OPERATOR_ROLE_IDS = [
  'super_admin',
  'ops_admin',
  'schedule_planner',
  'resource_coordinator',
  'viewer',
] as const;

export type OperatorRoleId = (typeof OPERATOR_ROLE_IDS)[number];

export const OPERATOR_PERMISSION_KEYS = [
  'dashboard.read',
  'seasonal.read',
  'seasonal.write',
  'detailed.read',
  'detailed.write',
  'daily.read',
  'daily.write',
  'checkin.read',
  'checkin.write',
  'gate.read',
  'gate.write',
  'settings.manage',
  'ai.use',
  'ai.manage',
  'audit.read',
  'users.manage',
  'roles.manage',
  'season.repair',
  'updates.manage',
  'diagnostics.read',
] as const;

export type OperatorPermissionKey = (typeof OPERATOR_PERMISSION_KEYS)[number];
export type OperatorPermissionEffect = 'allow' | 'deny';

export interface OperatorPermissionProfile {
  roles?: readonly unknown[];
  rolePermissions?: readonly unknown[];
  overrides?: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>>;
  canManageAi?: boolean;
  canUseAi?: boolean;
}

export interface OperatorRoleOption {
  id: OperatorRoleId;
  label: string;
  description: string;
}

export interface OperatorPermissionOption {
  id: OperatorPermissionKey;
  label: string;
  description: string;
}

export const OPERATOR_ROLE_OPTIONS: readonly OperatorRoleOption[] = [
  { id: 'super_admin', label: 'Super Admin', description: 'Full system owner.' },
  { id: 'ops_admin', label: 'Ops Admin', description: 'Daily operations administrator.' },
  { id: 'schedule_planner', label: 'Schedule Planner', description: 'Seasonal, Detailed, and Daily schedule editor.' },
  { id: 'resource_coordinator', label: 'Resource Coordinator', description: 'Check-in and Gate allocation editor.' },
  { id: 'viewer', label: 'Viewer', description: 'Read-only operator.' },
];

export const ROLE_DEFAULT_PERMISSIONS: Record<OperatorRoleId, readonly OperatorPermissionKey[]> = {
  super_admin: OPERATOR_PERMISSION_KEYS,
  ops_admin: [
    'dashboard.read',
    'seasonal.read',
    'seasonal.write',
    'detailed.read',
    'detailed.write',
    'daily.read',
    'daily.write',
    'checkin.read',
    'checkin.write',
    'gate.read',
    'gate.write',
    'settings.manage',
    'audit.read',
    'users.manage',
    'diagnostics.read',
  ],
  schedule_planner: [
    'dashboard.read',
    'seasonal.read',
    'seasonal.write',
    'detailed.read',
    'detailed.write',
    'daily.read',
    'daily.write',
    'checkin.read',
    'gate.read',
  ],
  resource_coordinator: [
    'dashboard.read',
    'seasonal.read',
    'detailed.read',
    'daily.read',
    'checkin.read',
    'checkin.write',
    'gate.read',
    'gate.write',
  ],
  viewer: [
    'dashboard.read',
    'seasonal.read',
    'detailed.read',
    'daily.read',
    'checkin.read',
    'gate.read',
  ],
};

export const OPERATOR_EXTRA_CAPABILITY_OPTIONS: readonly OperatorPermissionOption[] = [
  { id: 'ai.use', label: 'AI Use', description: 'Use Dashboard AI/local AI agent.' },
  { id: 'ai.manage', label: 'AI Manage', description: 'Manage AI provider keys, models, and context.' },
  { id: 'audit.read', label: 'Audit Read', description: 'Read Audit Log.' },
  { id: 'settings.manage', label: 'Settings Manage', description: 'Manage operational settings.' },
  { id: 'season.repair', label: 'Season Repair', description: 'Run season repair/import repair flows.' },
  { id: 'updates.manage', label: 'Updates Manage', description: 'Manage desktop update actions.' },
  { id: 'diagnostics.read', label: 'Diagnostics Read', description: 'Read support diagnostics.' },
];

export function isOperatorRoleId(value: unknown): value is OperatorRoleId {
  return typeof value === 'string' && (OPERATOR_ROLE_IDS as readonly string[]).includes(value);
}

export function isOperatorPermissionKey(value: unknown): value is OperatorPermissionKey {
  return typeof value === 'string' && (OPERATOR_PERMISSION_KEYS as readonly string[]).includes(value);
}

export function normalizeOperatorRoleIds(values: readonly unknown[] | undefined): OperatorRoleId[] {
  return Array.from(new Set((values ?? []).filter(isOperatorRoleId)));
}

export function normalizeOperatorPermissionKeys(values: readonly unknown[] | undefined): OperatorPermissionKey[] {
  return Array.from(new Set((values ?? []).filter(isOperatorPermissionKey)));
}

export function resolveOperatorPermissions(profile: OperatorPermissionProfile): Set<OperatorPermissionKey> {
  const permissions = new Set<OperatorPermissionKey>();
  const roles = normalizeOperatorRoleIds(profile.roles);

  for (const roleId of roles) {
    for (const permission of ROLE_DEFAULT_PERMISSIONS[roleId]) {
      permissions.add(permission);
    }
  }

  for (const permission of normalizeOperatorPermissionKeys(profile.rolePermissions)) {
    permissions.add(permission);
  }

  if (profile.canManageAi === true) {
    permissions.add('ai.manage');
    permissions.add('ai.use');
  } else if (profile.canUseAi === true) {
    permissions.add('ai.use');
  }

  for (const [permission, effect] of Object.entries(profile.overrides ?? {})) {
    if (!isOperatorPermissionKey(permission)) continue;
    if (effect === 'deny') permissions.delete(permission);
    if (effect === 'allow') permissions.add(permission);
  }

  return permissions;
}

export function hasOperatorPermission(
  permissions: ReadonlySet<OperatorPermissionKey> | readonly OperatorPermissionKey[],
  permission: OperatorPermissionKey
): boolean {
  return permissions instanceof Set ? permissions.has(permission) : permissions.includes(permission);
}

export function canAssignOperatorRole(
  actorPermissions: ReadonlySet<OperatorPermissionKey> | readonly OperatorPermissionKey[],
  roleId: OperatorRoleId
): boolean {
  if (!hasOperatorPermission(actorPermissions, 'users.manage')) return false;
  if (roleId === 'super_admin') return hasOperatorPermission(actorPermissions, 'roles.manage');
  return true;
}

export function canGrantOperatorPermission(
  actorPermissions: ReadonlySet<OperatorPermissionKey> | readonly OperatorPermissionKey[],
  permission: OperatorPermissionKey
): boolean {
  if (!hasOperatorPermission(actorPermissions, 'users.manage')) return false;
  if (permission === 'roles.manage') return hasOperatorPermission(actorPermissions, 'roles.manage');
  if (permission === 'users.manage') return hasOperatorPermission(actorPermissions, 'roles.manage');
  return true;
}

export function validateOperatorAssignment(input: {
  actorPermissions: ReadonlySet<OperatorPermissionKey> | readonly OperatorPermissionKey[];
  roleId: OperatorRoleId;
  extraPermissions?: readonly OperatorPermissionKey[];
}): { ok: true } | { ok: false; reason: string } {
  if (!canAssignOperatorRole(input.actorPermissions, input.roleId)) {
    return { ok: false, reason: input.roleId === 'super_admin' ? 'super_admin requires roles.manage' : 'users.manage is required' };
  }
  for (const permission of input.extraPermissions ?? []) {
    if (!canGrantOperatorPermission(input.actorPermissions, permission)) {
      return { ok: false, reason: `${permission} requires roles.manage` };
    }
  }
  return { ok: true };
}
