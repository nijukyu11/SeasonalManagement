'use client';

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { operatorUsernameToTechnicalEmail } from '@/lib/operatorAuthIdentity';
import {
  OPERATOR_EXTRA_CAPABILITY_OPTIONS,
  OPERATOR_ROLE_OPTIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type OperatorPermissionKey,
  type OperatorRoleId,
} from '@/lib/operatorPermissions';
import {
  createOperatorUser,
  listOperatorUsers,
  type OperatorUserSummary,
} from '@/lib/operatorUserManagement';

type DialogTone = 'info' | 'success' | 'warning' | 'error';

type UsersRolesTabProps = {
  canManageRoles: boolean;
  setStatus: Dispatch<SetStateAction<string | null>>;
  showAlert: (messageOrOptions: string | { title?: string; message: string; tone?: DialogTone; confirmLabel?: string; cancelLabel?: string }) => Promise<void>;
};

function roleLabel(roleId: OperatorRoleId): string {
  return OPERATOR_ROLE_OPTIONS.find((role) => role.id === roleId)?.label ?? roleId;
}

function permissionLabel(permission: OperatorPermissionKey): string {
  return OPERATOR_EXTRA_CAPABILITY_OPTIONS.find((option) => option.id === permission)?.label ?? permission;
}

function operatorLabel(operator: OperatorUserSummary): string {
  return operator.displayName ?? operator.username ?? operator.email ?? operator.userId;
}

function sortOperators(operators: OperatorUserSummary[]): OperatorUserSummary[] {
  return [...operators].sort((left, right) => operatorLabel(left).localeCompare(operatorLabel(right)));
}

export default function UsersRolesTab({ canManageRoles, setStatus, showAlert }: UsersRolesTabProps) {
  const [operators, setOperators] = useState<OperatorUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<OperatorRoleId>('viewer');
  const [extraPermissions, setExtraPermissions] = useState<OperatorPermissionKey[]>([]);

  const roleOptions = useMemo(() => (
    canManageRoles ? OPERATOR_ROLE_OPTIONS : OPERATOR_ROLE_OPTIONS.filter((role) => role.id !== 'super_admin')
  ), [canManageRoles]);

  useEffect(() => {
    if (!canManageRoles && roleId === 'super_admin') setRoleId('viewer');
  }, [canManageRoles, roleId]);

  const rolePermissionSet = useMemo(() => new Set<OperatorPermissionKey>(ROLE_DEFAULT_PERMISSIONS[roleId]), [roleId]);
  const technicalEmail = useMemo(() => {
    try {
      return username.trim() ? operatorUsernameToTechnicalEmail(username) : '';
    } catch {
      return '';
    }
  }, [username]);

  const reloadOperators = useCallback(async () => {
    setLoading(true);
    try {
      setOperators(sortOperators(await listOperatorUsers()));
    } catch (err) {
      void showAlert({ title: 'Load Users Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [showAlert]);

  useEffect(() => {
    void reloadOperators();
  }, [reloadOperators]);

  const toggleExtraPermission = (permission: OperatorPermissionKey) => {
    if (rolePermissionSet.has(permission)) return;
    setExtraPermissions((current) => (
      current.includes(permission)
        ? current.filter((entry) => entry !== permission)
        : [...current, permission]
    ));
  };

  const handleRoleChange = (nextRole: OperatorRoleId) => {
    const nextDefaults = new Set<OperatorPermissionKey>(ROLE_DEFAULT_PERMISSIONS[nextRole]);
    setRoleId(nextRole);
    setExtraPermissions((current) => current.filter((permission) => !nextDefaults.has(permission)));
  };

  const resetForm = () => {
    setUsername('');
    setDisplayName('');
    setPassword('');
    setRoleId('viewer');
    setExtraPermissions([]);
  };

  const createUser = async () => {
    setCreating(true);
    try {
      const created = await createOperatorUser({
        username,
        displayName,
        password,
        roleId,
        extraPermissions,
      });
      setOperators((current) => sortOperators([created, ...current.filter((operator) => operator.userId !== created.userId)]));
      resetForm();
      setStatus(`Created operator ${operatorLabel(created)}`);
      void reloadOperators();
    } catch (err) {
      void showAlert({ title: 'Create User Failed', message: (err as Error).message, tone: 'error' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <form
        className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void createUser();
        }}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary-container text-primary">
            <span className="material-symbols-outlined text-[22px]">person_add</span>
          </div>
          <div>
            <h2 className="font-title-md text-title-md text-on-surface">Create User</h2>
            <p className="mt-1 text-sm text-on-surface-variant">Initial operator account</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          <label className="block text-sm font-semibold text-on-surface">
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              placeholder="planner01"
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              placeholder="Planning Admin"
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <label className="block text-sm font-semibold text-on-surface">
            Role
            <select
              value={roleId}
              onChange={(event) => handleRoleChange(event.target.value as OperatorRoleId)}
              className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            >
              {roleOptions.map((role) => (
                <option key={role.id} value={role.id}>{role.label}</option>
              ))}
            </select>
          </label>
          <div className="rounded-lg border border-outline-variant bg-surface-container px-3 py-2 text-xs font-semibold text-on-surface-variant">
            {technicalEmail || 'Technical email is derived after username is valid'}
          </div>
        </div>

        <div className="mt-5">
          <h3 className="text-sm font-semibold text-on-surface">Extra capabilities</h3>
          <div className="mt-2 grid gap-2">
            {OPERATOR_EXTRA_CAPABILITY_OPTIONS.map((option) => {
              const includedByRole = rolePermissionSet.has(option.id);
              const checked = includedByRole || extraPermissions.includes(option.id);
              return (
                <label key={option.id} className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${includedByRole ? 'border-surface-variant bg-surface-container text-on-surface-variant' : 'border-outline-variant bg-surface text-on-surface'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={includedByRole}
                    onChange={() => toggleExtraPermission(option.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold">{option.label}</span>
                    <span className="block text-xs text-on-surface-variant">{includedByRole ? 'Included by selected role' : option.id}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          disabled={creating}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={`material-symbols-outlined text-[18px] ${creating ? 'animate-spin' : ''}`}>{creating ? 'progress_activity' : 'person_add'}</span>
          {creating ? 'Creating' : 'Create User'}
        </button>
      </form>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-variant px-4 py-3">
          <div>
            <h2 className="font-title-md text-title-md text-on-surface">Users & Roles</h2>
            <p className="mt-1 text-sm text-on-surface-variant">{operators.length} operator account(s)</p>
          </div>
          <button
            type="button"
            onClick={() => void reloadOperators()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>{loading ? 'progress_activity' : 'refresh'}</span>
            Refresh
          </button>
        </div>

        <div className="hidden grid-cols-[160px_170px_minmax(170px,1fr)_170px_minmax(160px,1fr)] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant xl:grid">
          <span>User</span>
          <span>Username</span>
          <span>Email</span>
          <span>Role</span>
          <span>Capabilities</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            Loading users
          </div>
        ) : operators.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No operators found</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {operators.map((operator) => {
              const extraCapabilities = OPERATOR_EXTRA_CAPABILITY_OPTIONS
                .filter((option) => operator.permissions.includes(option.id))
                .map((option) => option.id);
              return (
                <div key={operator.userId} className="grid gap-3 p-4 xl:grid-cols-[160px_170px_minmax(170px,1fr)_170px_minmax(160px,1fr)] xl:items-center">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-on-surface">{operator.displayName ?? 'No display name'}</div>
                    <div className="truncate text-xs text-on-surface-variant">{operator.userId}</div>
                  </div>
                  <div className="truncate text-sm text-on-surface">{operator.username ?? '-'}</div>
                  <div className="truncate text-sm text-on-surface">{operator.email ?? '-'}</div>
                  <div className="flex flex-wrap gap-1">
                    {operator.roles.length === 0 ? (
                      <span className="rounded-full border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface-variant">No role</span>
                    ) : operator.roles.map((role) => (
                      <span key={role} className="rounded-full border border-primary/30 bg-primary-container/30 px-2 py-1 text-xs font-semibold text-primary">
                        {roleLabel(role)}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {extraCapabilities.length === 0 ? (
                      <span className="text-xs text-on-surface-variant">-</span>
                    ) : extraCapabilities.map((permission) => (
                      <span key={permission} className="rounded-full border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface-variant">
                        {permissionLabel(permission)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
