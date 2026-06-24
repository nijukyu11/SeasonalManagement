# Operator Roles User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five application roles, resolve operator capabilities from database-backed assignments, and expose a Settings user creation screen for admins. `ops_admin` can create users, but only `super_admin` can assign `super_admin` or manage role templates.

**Architecture:** Supabase Auth remains the password/session boundary. Application authorization is stored in `public.app_roles`, `public.app_role_permissions`, `public.app_operator_roles`, and `public.app_operator_permission_overrides`. The static Next/Tauri frontend calls a Supabase Edge Function for privileged user creation so the service role key never enters the frontend bundle.

**Tech Stack:** Next.js static export, React 19, TypeScript, Supabase JS, Supabase Edge Functions, Postgres migrations, Node test runner.

---

## Task 1: Add Permission Model And Schema

- [ ] Create a migration that adds role and permission tables.
- [ ] Seed the five approved roles: `super_admin`, `ops_admin`, `schedule_planner`, `resource_coordinator`, `viewer`.
- [ ] Seed default permissions and compatibility AI permissions.
- [ ] Bootstrap current operators so existing access is not locked out:
  - `username = 'admin'` gets `super_admin`.
  - other existing operators without a role get `ops_admin`.
- [ ] Add Postgres helpers:
  - `public.app_operator_has_permission_for(p_user_id uuid, p_permission_key text)`
  - `public.app_operator_has_permission(p_permission_key text)`
- [ ] Add RLS policies that let authenticated app operators read role metadata but keep writes server-side.
- [ ] Update `app/supabase/schema.sql` to match the migration.
- [ ] Add or update source/schema guard tests for the new role tables and helper functions.

Verification:

```powershell
cd app
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

## Task 2: Add Shared Frontend Permission Helper

- [ ] Add `app/src/lib/operatorPermissions.ts`.
- [ ] Encode approved role ids and permission keys as typed constants.
- [ ] Resolve effective permissions from roles, role defaults, overrides, and legacy AI flags.
- [ ] Add assignment guards:
  - `super_admin` can assign any role.
  - `ops_admin` can assign non-`super_admin` roles.
  - only `super_admin` can grant `roles.manage`.
- [ ] Add focused tests for role defaults, deny precedence, AI compatibility, and assignment guards.

Verification:

```powershell
cd app
node --experimental-strip-types --test src/lib/operatorPermissions.test.ts
```

## Task 3: Add Server-Only User Management Function

- [ ] Add `app/supabase/functions/operator-user-management/index.ts`.
- [ ] Validate the bearer session with Supabase Auth.
- [ ] Resolve the actor's permissions from role tables using the service-role client.
- [ ] Implement `list` action for operators and assigned roles.
- [ ] Implement `createUser` action:
  - normalize username.
  - derive `<username>@operators.local.ahtops`.
  - require `users.manage`.
  - enforce assignment restrictions.
  - call `auth.admin.createUser`.
  - insert `app_operators`, `app_operator_roles`, and requested capability overrides.
- [ ] Add `app/src/lib/operatorUserManagement.ts` as the frontend wrapper around `invokeSupabaseFunction`.
- [ ] Add source guard coverage ensuring the frontend wrapper uses the Edge Function and no service role is imported into client code.

Verification:

```powershell
cd app
node --experimental-strip-types --test src/lib/operatorUserManagement.test.ts
```

## Task 4: Add Settings Users & Roles Tab

- [ ] Add `app/src/app/settings/components/UsersRolesTab.tsx`.
- [ ] Add a typed access loader so Settings can know whether the current operator has `users.manage`.
- [ ] Add `Users & Roles` tab only when the current operator has `users.manage`.
- [ ] Provide a create-user form with username, display name, password, role, and extra capabilities.
- [ ] Show existing operators with username, display name, technical email, roles, AI flags, and extra capabilities.
- [ ] Keep the create-user form independent from the existing Settings "Save Settings" dirty state.
- [ ] Add a source guard test for the tab visibility and static-export-safe implementation.

Verification:

```powershell
cd app
npm run build
```

## Task 5: Apply And Smoke On Self-Hosted Server

- [ ] Apply the role migration to the self-hosted Postgres server over the approved SSH path.
- [ ] Verify `admin` has `super_admin` and `users.manage`.
- [ ] Deploy or place the new Edge Function according to the current server function deployment layout.
- [ ] Smoke list/create behavior with a non-production test user if the function endpoint is available.
- [ ] Document any server step that cannot be completed locally.

Verification:

```powershell
ssh ops@100.91.158.79
```

Run SQL checks:

```sql
select public.app_operator_has_permission_for(user_id, 'users.manage')
from public.app_operators
where username = 'admin';
```

## Task 6: Final Verification

- [ ] Run focused unit/source tests.
- [ ] Run `npm run build`.
- [ ] Scan changed Vietnamese/non-ASCII docs for mojibake markers.
- [ ] Commit only intentional files.
- [ ] Report implemented files, verification results, and any live-server limitations.
