import {
  OPERATOR_EXTRA_CAPABILITY_OPTIONS,
  type OperatorPermissionEffect,
  type OperatorPermissionKey,
  type OperatorRoleId,
  normalizeOperatorPermissionKeys,
  normalizeOperatorRoleIds,
  resolveOperatorPermissions,
} from './operatorPermissions';
import { getSupabaseClient, invokeSupabaseFunction } from './supabase';

export interface OperatorUserSummary {
  userId: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  roles: OperatorRoleId[];
  permissions: OperatorPermissionKey[];
  permissionOverrides: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>>;
  canManageAi: boolean;
  canUseAi: boolean;
  createdAt: string | null;
}

export interface CreateOperatorUserInput {
  username: string;
  displayName: string;
  password: string;
  roleId: OperatorRoleId;
  extraPermissions?: OperatorPermissionKey[];
}

export interface CurrentOperatorAccess {
  roles: OperatorRoleId[];
  permissions: Set<OperatorPermissionKey>;
  canManageUsers: boolean;
  canManageAi: boolean;
  canUseAi: boolean;
}

interface OperatorUserManagementListResponse {
  operators?: unknown;
}

interface OperatorUserManagementCreateResponse {
  operator?: unknown;
}

export async function listOperatorUsers(): Promise<OperatorUserSummary[]> {
  const payload = await invokeSupabaseFunction<OperatorUserManagementListResponse>('operator-user-management', {
    action: 'list',
  });
  return normalizeOperatorUsers(payload.operators);
}

export async function createOperatorUser(input: CreateOperatorUserInput): Promise<OperatorUserSummary> {
  const payload = await invokeSupabaseFunction<OperatorUserManagementCreateResponse>('operator-user-management', {
    action: 'createUser',
    username: input.username,
    displayName: input.displayName,
    password: input.password,
    roleId: input.roleId,
    extraPermissions: input.extraPermissions ?? [],
  });
  const [operator] = normalizeOperatorUsers([payload.operator]);
  if (!operator) throw new Error('operator-user-management: created operator payload is invalid');
  return operator;
}

export async function getCurrentOperatorAccess(): Promise<CurrentOperatorAccess> {
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const userId = userData.user?.id;
  if (!userId) return emptyAccess();

  const { data: operator, error: operatorError } = await supabase
    .from('app_operators')
    .select('can_manage_ai,can_use_ai')
    .eq('user_id', userId)
    .maybeSingle();
  if (operatorError) throw new Error(operatorError.message);
  if (!operator) return emptyAccess();

  const { data: roleRows, error: rolesError } = await supabase
    .from('app_operator_roles')
    .select('role_id')
    .eq('user_id', userId);
  if (rolesError) throw new Error(rolesError.message);
  const roles = normalizeOperatorRoleIds((roleRows ?? []).map((row) => row.role_id));

  const { data: permissionRows, error: permissionsError } = roles.length > 0
    ? await supabase.from('app_role_permissions').select('permission_key').in('role_id', roles)
    : { data: [], error: null };
  if (permissionsError) throw new Error(permissionsError.message);
  const rolePermissions = normalizeOperatorPermissionKeys((permissionRows ?? []).map((row) => row.permission_key));

  const { data: overrideRows, error: overridesError } = await supabase
    .from('app_operator_permission_overrides')
    .select('permission_key,effect')
    .eq('user_id', userId);
  if (overridesError) throw new Error(overridesError.message);

  const overrides: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>> = {};
  for (const row of overrideRows ?? []) {
    const [permission] = normalizeOperatorPermissionKeys([row.permission_key]);
    if (permission && (row.effect === 'allow' || row.effect === 'deny')) overrides[permission] = row.effect;
  }

  const canManageAi = operator.can_manage_ai === true;
  const permissions = resolveOperatorPermissions({
    roles,
    rolePermissions,
    overrides,
    canManageAi,
    canUseAi: operator.can_use_ai === true,
  });
  return {
    roles,
    permissions,
    canManageUsers: permissions.has('users.manage'),
    canManageAi: permissions.has('ai.manage'),
    canUseAi: permissions.has('ai.use'),
  };
}

function emptyAccess(): CurrentOperatorAccess {
  return {
    roles: [],
    permissions: new Set(),
    canManageUsers: false,
    canManageAi: false,
    canUseAi: false,
  };
}

function normalizeOperatorUsers(value: unknown): OperatorUserSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const roles = normalizeOperatorRoleIds(Array.isArray(row.roles) ? row.roles : []);
    const permissions = normalizeOperatorPermissionKeys(Array.isArray(row.permissions) ? row.permissions : []);
    const permissionOverrides = normalizePermissionOverrides(row.permissionOverrides);
    return [{
      userId: stringOrNull(row.userId) ?? '',
      email: stringOrNull(row.email),
      username: stringOrNull(row.username),
      displayName: stringOrNull(row.displayName),
      roles,
      permissions,
      permissionOverrides,
      canManageAi: row.canManageAi === true,
      canUseAi: row.canUseAi === true,
      createdAt: stringOrNull(row.createdAt),
    }];
  }).filter((operator) => operator.userId);
}

function normalizePermissionOverrides(value: unknown): Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>> = {};
  for (const option of OPERATOR_EXTRA_CAPABILITY_OPTIONS) {
    const effect = (value as Partial<Record<OperatorPermissionKey, unknown>>)[option.id];
    if (effect === 'allow' || effect === 'deny') normalized[option.id] = effect;
  }
  return normalized;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}
