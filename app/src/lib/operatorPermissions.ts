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
  { id: 'super_admin', label: 'Quản trị cấp cao', description: 'Toàn quyền quản trị hệ thống.' },
  { id: 'ops_admin', label: 'Quản trị vận hành', description: 'Quản trị viên vận hành hàng ngày.' },
  { id: 'schedule_planner', label: 'Điều phối viên kế hoạch', description: 'Biên tập lịch mùa, lịch chi tiết và lịch ngày.' },
  { id: 'resource_coordinator', label: 'Điều phối viên tài nguyên', description: 'Biên tập phân bổ quầy thủ tục và cửa khởi hành.' },
  { id: 'viewer', label: 'Người xem', description: 'Chỉ xem dữ liệu.' },
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
  { id: 'ai.use', label: 'Sử dụng AI', description: 'Sử dụng trợ lý AI trên tổng quan hoặc AI nội bộ.' },
  { id: 'ai.manage', label: 'Quản lý AI', description: 'Quản lý khóa nhà cung cấp AI, mô hình và ngữ cảnh.' },
  { id: 'audit.read', label: 'Xem lịch sử thao tác', description: 'Đọc nhật ký thao tác hệ thống.' },
  { id: 'settings.manage', label: 'Quản lý cài đặt', description: 'Quản lý các cài đặt vận hành.' },
  { id: 'season.repair', label: 'Khôi phục lịch mùa', description: 'Thực hiện quy trình khôi phục hoặc xử lý lỗi lịch mùa.' },
  { id: 'updates.manage', label: 'Quản lý cập nhật', description: 'Quản lý cập nhật phiên bản ứng dụng.' },
  { id: 'diagnostics.read', label: 'Xem chẩn đoán', description: 'Đọc thông tin chẩn đoán hỗ trợ kỹ thuật.' },
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
  return isReadonlyPermissionSet(permissions) ? permissions.has(permission) : permissions.includes(permission);
}

function isReadonlyPermissionSet(
  value: ReadonlySet<OperatorPermissionKey> | readonly OperatorPermissionKey[]
): value is ReadonlySet<OperatorPermissionKey> {
  return typeof (value as ReadonlySet<OperatorPermissionKey>).has === 'function';
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
    return { ok: false, reason: input.roleId === 'super_admin' ? 'Cần có quyền roles.manage để gán vai trò super_admin' : 'Cần có quyền users.manage' };
  }
  for (const permission of input.extraPermissions ?? []) {
    if (!canGrantOperatorPermission(input.actorPermissions, permission)) {
      return { ok: false, reason: `Cần có quyền roles.manage để cấp quyền ${permission}` };
    }
  }
  return { ok: true };
}
