import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const OPERATOR_TECHNICAL_EMAIL_DOMAIN = 'operators.local.ahtops';
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])$/;
const MIN_PASSWORD_LENGTH = 8;

const OPERATOR_ROLE_IDS = [
  'super_admin',
  'ops_admin',
  'schedule_planner',
  'resource_coordinator',
  'viewer',
] as const;

type OperatorRoleId = (typeof OPERATOR_ROLE_IDS)[number];

const OPERATOR_PERMISSION_KEYS = [
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

type OperatorPermissionKey = (typeof OPERATOR_PERMISSION_KEYS)[number];
type OperatorPermissionEffect = 'allow' | 'deny';
type SupabaseClient = ReturnType<typeof createClient>;

interface OperatorRow {
  user_id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  can_manage_ai: boolean;
  can_use_ai: boolean;
  created_at?: string | null;
}

interface OperatorUserSummary {
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

interface CreateUserBody {
  action: 'createUser';
  username?: unknown;
  displayName?: unknown;
  password?: unknown;
  roleId?: unknown;
  extraPermissions?: unknown;
}

interface ListUsersBody {
  action: 'list';
}

type OperatorUserManagementBody = CreateUserBody | ListUsersBody | Record<string, unknown>;

const ROLE_DEFAULT_PERMISSIONS: Record<OperatorRoleId, readonly OperatorPermissionKey[]> = {
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      getPublishableKey(),
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', getServiceKey());
    const actorProfile = await loadPermissionProfile(admin, userData.user.id);
    if (!actorProfile) return jsonResponse({ error: 'Operator access is required' }, 403);
    const actorPermissions = resolvePermissions(actorProfile);
    if (!actorPermissions.has('users.manage')) return jsonResponse({ error: 'users.manage permission is required' }, 403);

    const body = await readBody(req);
    if (body.action === 'list') {
      return jsonResponse({ operators: await listOperatorUsers(admin) });
    }
    if (body.action === 'createUser') {
      const created = await createOperatorUser(admin, body, actorPermissions);
      return jsonResponse({ operator: created }, 201);
    }

    return jsonResponse({ error: 'Unsupported operator user management action' }, 400);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return jsonResponse({ error: errorMessage(error) }, status);
  }
});

async function listOperatorUsers(admin: SupabaseClient): Promise<OperatorUserSummary[]> {
  const { data: operators, error: operatorsError } = await admin
    .from('app_operators')
    .select('user_id,email,username,display_name,can_manage_ai,can_use_ai,created_at')
    .order('username', { ascending: true, nullsFirst: false })
    .order('email', { ascending: true, nullsFirst: false });
  if (operatorsError) throw operatorsError;

  const rows = (operators ?? []) as OperatorRow[];
  return summarizeOperators(admin, rows);
}

async function createOperatorUser(
  admin: SupabaseClient,
  body: CreateUserBody,
  actorPermissions: Set<OperatorPermissionKey>
): Promise<OperatorUserSummary> {
  const username = normalizeUsername(body.username);
  const displayName = normalizeDisplayName(body.displayName);
  const password = normalizePassword(body.password);
  const roleId = normalizeRoleId(body.roleId);
  const extraPermissions = normalizePermissionKeys(body.extraPermissions);

  const assignment = validateAssignment(actorPermissions, roleId, extraPermissions);
  if (!assignment.ok) throw new HttpError(403, assignment.reason);

  const email = `${username}@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`;
  const existingOperator = await findExistingOperator(admin, username, email);
  if (existingOperator) throw new HttpError(409, 'Username đã tồn tại.');

  const requestedPermissions = new Set<OperatorPermissionKey>([
    ...ROLE_DEFAULT_PERMISSIONS[roleId],
    ...extraPermissions,
  ]);
  const canManageAi = requestedPermissions.has('ai.manage');
  const canUseAi = canManageAi || requestedPermissions.has('ai.use');

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      name: displayName,
      username,
    },
    app_metadata: {
      operator_username: username,
    },
  });
  if (authError || !authData.user) {
    throw new HttpError(isDuplicateAuthError(authError?.message) ? 409 : 400, authError?.message ?? 'Unable to create Auth user.');
  }

  try {
    const operatorRow = {
      user_id: authData.user.id,
      email,
      username,
      display_name: displayName,
      can_manage_ai: canManageAi,
      can_use_ai: canUseAi,
    };
    const { error: operatorError } = await admin.from('app_operators').insert(operatorRow);
    if (operatorError) throw operatorError;

    const { error: roleError } = await admin.from('app_operator_roles').insert({
      user_id: authData.user.id,
      role_id: roleId,
    });
    if (roleError) throw roleError;

    const overrideRows = extraPermissions.map((permission) => ({
      user_id: authData.user.id,
      permission_key: permission,
      effect: 'allow',
    }));
    if (overrideRows.length > 0) {
      const { error: overridesError } = await admin.from('app_operator_permission_overrides').insert(overrideRows);
      if (overridesError) throw overridesError;
    }

    const [summary] = await summarizeOperators(admin, [{ ...operatorRow, created_at: null }]);
    return summary;
  } catch (error) {
    await admin.auth.admin.deleteUser(authData.user.id).catch(() => null);
    throw error;
  }
}

async function summarizeOperators(admin: SupabaseClient, operators: OperatorRow[]): Promise<OperatorUserSummary[]> {
  const userIds = operators.map((operator) => operator.user_id);
  if (userIds.length === 0) return [];

  const { data: roleRows, error: rolesError } = await admin
    .from('app_operator_roles')
    .select('user_id,role_id')
    .in('user_id', userIds);
  if (rolesError) throw rolesError;

  const { data: permissionRows, error: permissionsError } = await admin
    .from('app_role_permissions')
    .select('role_id,permission_key');
  if (permissionsError) throw permissionsError;

  const { data: overrideRows, error: overridesError } = await admin
    .from('app_operator_permission_overrides')
    .select('user_id,permission_key,effect')
    .in('user_id', userIds);
  if (overridesError) throw overridesError;

  const permissionsByRole = new Map<OperatorRoleId, OperatorPermissionKey[]>();
  for (const row of permissionRows ?? []) {
    const roleId = normalizeRoleIdOrNull((row as { role_id?: unknown }).role_id);
    const permission = normalizePermissionKeyOrNull((row as { permission_key?: unknown }).permission_key);
    if (!roleId || !permission) continue;
    const permissions = permissionsByRole.get(roleId) ?? [];
    permissions.push(permission);
    permissionsByRole.set(roleId, permissions);
  }

  const rolesByUser = new Map<string, OperatorRoleId[]>();
  for (const row of roleRows ?? []) {
    const userId = String((row as { user_id?: unknown }).user_id ?? '');
    const roleId = normalizeRoleIdOrNull((row as { role_id?: unknown }).role_id);
    if (!userId || !roleId) continue;
    const roles = rolesByUser.get(userId) ?? [];
    roles.push(roleId);
    rolesByUser.set(userId, roles);
  }

  const overridesByUser = new Map<string, Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>>>();
  for (const row of overrideRows ?? []) {
    const userId = String((row as { user_id?: unknown }).user_id ?? '');
    const permission = normalizePermissionKeyOrNull((row as { permission_key?: unknown }).permission_key);
    const effect = (row as { effect?: unknown }).effect;
    if (!userId || !permission || (effect !== 'allow' && effect !== 'deny')) continue;
    const overrides = overridesByUser.get(userId) ?? {};
    overrides[permission] = effect;
    overridesByUser.set(userId, overrides);
  }

  return operators.map((operator) => {
    const roles = Array.from(new Set(rolesByUser.get(operator.user_id) ?? []));
    const rolePermissions = roles.flatMap((roleId) => permissionsByRole.get(roleId) ?? ROLE_DEFAULT_PERMISSIONS[roleId]);
    const permissionOverrides = overridesByUser.get(operator.user_id) ?? {};
    const permissions = Array.from(resolvePermissions({
      roles,
      rolePermissions,
      overrides: permissionOverrides,
      canManageAi: operator.can_manage_ai,
      canUseAi: operator.can_use_ai,
    })).sort();
    return {
      userId: operator.user_id,
      email: operator.email,
      username: operator.username,
      displayName: operator.display_name,
      roles,
      permissions,
      permissionOverrides,
      canManageAi: operator.can_manage_ai,
      canUseAi: operator.can_use_ai,
      createdAt: operator.created_at ?? null,
    };
  });
}

async function loadPermissionProfile(admin: SupabaseClient, userId: string): Promise<{
  roles: OperatorRoleId[];
  rolePermissions: OperatorPermissionKey[];
  overrides: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>>;
  canManageAi: boolean;
  canUseAi: boolean;
} | null> {
  const { data: operator, error: operatorError } = await admin
    .from('app_operators')
    .select('user_id,can_manage_ai,can_use_ai')
    .eq('user_id', userId)
    .maybeSingle();
  if (operatorError) throw operatorError;
  if (!operator) return null;

  const { data: roleRows, error: rolesError } = await admin
    .from('app_operator_roles')
    .select('role_id')
    .eq('user_id', userId);
  if (rolesError) throw rolesError;
  const roles = Array.from(new Set((roleRows ?? []).flatMap((row) => {
    const roleId = normalizeRoleIdOrNull((row as { role_id?: unknown }).role_id);
    return roleId ? [roleId] : [];
  })));

  const { data: permissionRows, error: permissionsError } = roles.length > 0
    ? await admin.from('app_role_permissions').select('permission_key').in('role_id', roles)
    : { data: [], error: null };
  if (permissionsError) throw permissionsError;
  const rolePermissions = Array.from(new Set((permissionRows ?? []).flatMap((row) => {
    const permission = normalizePermissionKeyOrNull((row as { permission_key?: unknown }).permission_key);
    return permission ? [permission] : [];
  })));

  const { data: overrideRows, error: overridesError } = await admin
    .from('app_operator_permission_overrides')
    .select('permission_key,effect')
    .eq('user_id', userId);
  if (overridesError) throw overridesError;
  const overrides: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>> = {};
  for (const row of overrideRows ?? []) {
    const permission = normalizePermissionKeyOrNull((row as { permission_key?: unknown }).permission_key);
    const effect = (row as { effect?: unknown }).effect;
    if (permission && (effect === 'allow' || effect === 'deny')) overrides[permission] = effect;
  }

  return {
    roles,
    rolePermissions,
    overrides,
    canManageAi: (operator as { can_manage_ai?: unknown }).can_manage_ai === true,
    canUseAi: (operator as { can_use_ai?: unknown }).can_use_ai === true,
  };
}

async function findExistingOperator(admin: SupabaseClient, username: string, email: string): Promise<boolean> {
  const { data, error } = await admin
    .from('app_operators')
    .select('user_id')
    .or(`username.eq.${username},email.eq.${email}`)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function resolvePermissions(profile: {
  roles?: readonly OperatorRoleId[];
  rolePermissions?: readonly OperatorPermissionKey[];
  overrides?: Partial<Record<OperatorPermissionKey, OperatorPermissionEffect>>;
  canManageAi?: boolean;
  canUseAi?: boolean;
}): Set<OperatorPermissionKey> {
  const permissions = new Set<OperatorPermissionKey>();
  for (const roleId of profile.roles ?? []) {
    for (const permission of ROLE_DEFAULT_PERMISSIONS[roleId]) permissions.add(permission);
  }
  for (const permission of profile.rolePermissions ?? []) permissions.add(permission);
  if (profile.canManageAi === true) {
    permissions.add('ai.manage');
    permissions.add('ai.use');
  } else if (profile.canUseAi === true) {
    permissions.add('ai.use');
  }
  for (const [permission, effect] of Object.entries(profile.overrides ?? {})) {
    const key = normalizePermissionKeyOrNull(permission);
    if (!key) continue;
    if (effect === 'deny') permissions.delete(key);
    if (effect === 'allow') permissions.add(key);
  }
  return permissions;
}

function validateAssignment(
  actorPermissions: Set<OperatorPermissionKey>,
  roleId: OperatorRoleId,
  extraPermissions: readonly OperatorPermissionKey[]
): { ok: true } | { ok: false; reason: string } {
  if (roleId === 'super_admin' && !actorPermissions.has('roles.manage')) {
    return { ok: false, reason: 'roles.manage is required to assign super_admin.' };
  }
  for (const permission of extraPermissions) {
    if ((permission === 'roles.manage' || permission === 'users.manage') && !actorPermissions.has('roles.manage')) {
      return { ok: false, reason: `roles.manage is required to grant ${permission}.` };
    }
  }
  return { ok: true };
}

function normalizeUsername(value: unknown): string {
  const username = String(value ?? '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new HttpError(400, 'Username không hợp lệ.');
  return username;
}

function normalizeDisplayName(value: unknown): string {
  const displayName = String(value ?? '').trim();
  if (!displayName) throw new HttpError(400, 'Display name is required.');
  if (displayName.length > 120) throw new HttpError(400, 'Display name is too long.');
  return displayName;
}

function normalizePassword(value: unknown): string {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  return password;
}

function normalizeRoleId(value: unknown): OperatorRoleId {
  const roleId = normalizeRoleIdOrNull(value);
  if (!roleId) throw new HttpError(400, 'Operator role is invalid.');
  return roleId;
}

function normalizeRoleIdOrNull(value: unknown): OperatorRoleId | null {
  return typeof value === 'string' && (OPERATOR_ROLE_IDS as readonly string[]).includes(value) ? value as OperatorRoleId : null;
}

function normalizePermissionKeys(value: unknown): OperatorPermissionKey[] {
  if (!Array.isArray(value)) return [];
  const keys: OperatorPermissionKey[] = [];
  for (const entry of value) {
    const key = normalizePermissionKeyOrNull(entry);
    if (!key) throw new HttpError(400, 'Operator permission is invalid.');
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function normalizePermissionKeyOrNull(value: unknown): OperatorPermissionKey | null {
  return typeof value === 'string' && (OPERATOR_PERMISSION_KEYS as readonly string[]).includes(value) ? value as OperatorPermissionKey : null;
}

async function readBody(req: Request): Promise<OperatorUserManagementBody> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body as OperatorUserManagementBody : {};
  } catch {
    return {};
  }
}

function parseSecretDictionary(name: string): Record<string, string> {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function getPublishableKey(): string {
  return Deno.env.get('SUPABASE_ANON_KEY')
    ?? parseSecretDictionary('SUPABASE_PUBLISHABLE_KEYS').default
    ?? '';
}

function getServiceKey(): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? parseSecretDictionary('SUPABASE_SECRET_KEYS').default;
  if (!key) throw new Error('Supabase service role secret is not configured');
  return key;
}

function isDuplicateAuthError(message: string | undefined): boolean {
  const normalized = (message ?? '').toLowerCase();
  return normalized.includes('already') || normalized.includes('registered') || normalized.includes('exists');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
