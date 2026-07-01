# Operator Roles And User Management Design

## Status

Approved design direction for adding role-based authorization and an admin user creation surface to SeasonalManagement after the username/password auth cutover.

Supabase Auth remains the authentication boundary. Application authorization stays table-backed through `public.app_operators` and related role tables, resolved from `auth.uid()`.

## Context

The app currently authorizes access by checking whether the signed-in Supabase Auth user has a row in `public.app_operators`. The table now contains operator profile fields:

- `user_id`
- `email`
- `username`
- `display_name`
- `can_manage_ai`
- `can_use_ai`

The existing AI flags should be treated as capabilities, not as the full permission model.

## Decision

Use five primary operator roles:

| Role | Purpose |
| --- | --- |
| `super_admin` | Full system owner. |
| `ops_admin` | Daily operations administrator. |
| `schedule_planner` | Seasonal, Detailed, and Daily schedule editor. |
| `resource_coordinator` | Check-in and Gate allocation editor. |
| `viewer` | Read-only operator. |

Do not keep separate `auditor` or `support_admin` roles. Their access becomes assignable capabilities.

## Capabilities

Capabilities are fine-grained permissions that can be granted by role defaults or explicit operator overrides:

| Capability | Meaning |
| --- | --- |
| `ai.use` | Use Dashboard AI/local AI agent. |
| `ai.manage` | Manage AI provider keys, models, and AI context. |
| `audit.read` | Read Audit Log. |
| `users.manage` | Create and update operator accounts. |
| `roles.manage` | Manage role templates and permission defaults. |
| `settings.manage` | Manage operational settings. |
| `season.repair` | Run season repair/import repair flows. |
| `updates.manage` | Manage desktop update actions. |
| `diagnostics.read` | Read support diagnostics. |

The existing `can_use_ai` and `can_manage_ai` columns remain compatibility fields for the current AI settings UI. The new permission resolver should map them into `ai.use` and `ai.manage` until the schema is fully consolidated.

## Default Permission Matrix

| Area | `viewer` | `resource_coordinator` | `schedule_planner` | `ops_admin` | `super_admin` |
| --- | --- | --- | --- | --- | --- |
| Dashboard | Read | Read | Read | Read | Full |
| Seasonal Schedule | Read | Read | Write | Write | Full |
| Detailed Schedule | Read | Read | Write | Write | Full |
| Daily Schedule | Read | Read | Write | Write | Full |
| Check-in Allocation | Read | Write | Read | Write | Full |
| Gate Allocation | Read | Write | Read | Write | Full |
| Operational Settings | No | Partial | No | Write | Full |
| AI Settings | No | No | No | Capability-gated | Full |
| Audit Log | No | No | No | Read | Full |
| User Management | No | No | No | Create non-super users | Full |
| Role Management | No | No | No | No | Full |
| Season Repair | No | No | No | Capability-gated | Full |
| Updates | No | No | No | Capability-gated | Full |

`ops_admin` can create operator users. To avoid accidental privilege escalation, only `super_admin` can create or assign `super_admin`, edit role templates, or grant capabilities beyond the allowed operational set.

## Data Model

Add role and permission tables rather than storing a single role string only:

```sql
create table public.app_roles (
  id text primary key,
  name text not null,
  description text not null default '',
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.app_role_permissions (
  role_id text not null references public.app_roles(id) on delete cascade,
  permission_key text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table public.app_operator_roles (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  role_id text not null references public.app_roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table public.app_operator_permission_overrides (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  permission_key text not null,
  effect text not null check (effect in ('allow', 'deny')),
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);
```

Seed the five system roles and their default permissions in the migration.

## Permission Resolution

Resolve permissions from:

1. Operator roles.
2. Role default capabilities.
3. Operator permission overrides.
4. Compatibility AI flags from `app_operators`.

Explicit `deny` overrides role-granted `allow`. `super_admin` should resolve to all known app permissions.

The frontend should use a typed permission helper, not ad hoc string checks in individual pages.

## Settings User Management UI

Add a Settings tab named `Users & Roles`.

The tab is visible only when the current operator has `users.manage`.

The first version should support:

- List operators with username, display name, technical email, roles, and selected capabilities.
- Create operator user.
- Update display name.
- Update assigned role.
- Toggle allowed extra capabilities.
- Disable or remove operator app access without deleting the Auth user.

The first version does not need password reset UX, but the create-user form must set an initial password.

## Create User Flow

The form fields are:

- Username
- Display name
- Password
- Role
- Extra capabilities

The app derives the technical email as:

```text
<username>@operators.local.ahtops
```

The client must not contain a Supabase `service_role` key.

User creation must run through a server-only API route or server action:

1. Check the current operator session.
2. Resolve current operator permissions from database tables.
3. Require `users.manage`.
4. Enforce assignment rules:
   - `super_admin` can assign any role.
   - `ops_admin` can create operator users but cannot assign `super_admin`.
   - `ops_admin` cannot grant `roles.manage`.
5. Call Supabase Auth Admin API to create the Auth user with the technical email and password.
6. Upsert `public.app_operators`.
7. Assign role rows and capability overrides.
8. Return the created operator profile without returning service keys or tokens.

## Security

- Supabase Auth remains responsible for password hashing, sessions, refresh tokens, and JWT issuance.
- Do not expose `service_role` or secret keys in the frontend bundle.
- Do not authorize from user-editable metadata.
- Do not create a public username lookup endpoint.
- Use `app_operators.user_id = auth.uid()` and server-side permission checks for privileged user-management actions.
- Keep app role names separate from Postgres roles. Application roles are data records, not database login roles.

## Testing

Regression coverage should include:

- Permission resolver grants expected role defaults.
- `deny` override wins over role grant.
- Existing `can_use_ai` and `can_manage_ai` map to AI capabilities.
- `ops_admin` can create non-super operator users.
- `ops_admin` cannot create or assign `super_admin`.
- `super_admin` can create any operator role.
- User creation derives the technical email from username.
- Frontend hides `Users & Roles` without `users.manage`.
- Settings tab guards user creation against missing permission.

## Out Of Scope

- Public signup.
- User self-service password reset.
- Department/team scoping.
- Per-season or per-airline permissions.
- Replacing Supabase Auth.
- Rewriting all existing RLS policies in the first slice.
