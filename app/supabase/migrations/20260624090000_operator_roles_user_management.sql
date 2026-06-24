create or replace function public.app_operator_known_permission_keys()
returns text[]
language sql
immutable
as $$
  select array[
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
    'diagnostics.read'
  ]::text[]
$$;

create table if not exists public.app_roles (
  id text primary key check (id ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text not null default '',
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.app_role_permissions (
  role_id text not null references public.app_roles(id) on delete cascade,
  permission_key text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists public.app_operator_roles (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  role_id text not null references public.app_roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table if not exists public.app_operator_permission_overrides (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  permission_key text not null,
  effect text not null check (effect in ('allow', 'deny')),
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);

insert into public.app_roles (id, name, description, is_system)
values
  ('super_admin', 'Super Admin', 'Full system owner.', true),
  ('ops_admin', 'Ops Admin', 'Daily operations administrator.', true),
  ('schedule_planner', 'Schedule Planner', 'Seasonal, Detailed, and Daily schedule editor.', true),
  ('resource_coordinator', 'Resource Coordinator', 'Check-in and Gate allocation editor.', true),
  ('viewer', 'Viewer', 'Read-only operator.', true)
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    is_system = excluded.is_system;

delete from public.app_role_permissions
where role_id in ('super_admin', 'ops_admin', 'schedule_planner', 'resource_coordinator', 'viewer');

with seeded_permissions(role_id, permission_key) as (
  values
    ('viewer', 'dashboard.read'),
    ('viewer', 'seasonal.read'),
    ('viewer', 'detailed.read'),
    ('viewer', 'daily.read'),
    ('viewer', 'checkin.read'),
    ('viewer', 'gate.read'),
    ('resource_coordinator', 'dashboard.read'),
    ('resource_coordinator', 'seasonal.read'),
    ('resource_coordinator', 'detailed.read'),
    ('resource_coordinator', 'daily.read'),
    ('resource_coordinator', 'checkin.read'),
    ('resource_coordinator', 'checkin.write'),
    ('resource_coordinator', 'gate.read'),
    ('resource_coordinator', 'gate.write'),
    ('schedule_planner', 'dashboard.read'),
    ('schedule_planner', 'seasonal.read'),
    ('schedule_planner', 'seasonal.write'),
    ('schedule_planner', 'detailed.read'),
    ('schedule_planner', 'detailed.write'),
    ('schedule_planner', 'daily.read'),
    ('schedule_planner', 'daily.write'),
    ('schedule_planner', 'checkin.read'),
    ('schedule_planner', 'gate.read'),
    ('ops_admin', 'dashboard.read'),
    ('ops_admin', 'seasonal.read'),
    ('ops_admin', 'seasonal.write'),
    ('ops_admin', 'detailed.read'),
    ('ops_admin', 'detailed.write'),
    ('ops_admin', 'daily.read'),
    ('ops_admin', 'daily.write'),
    ('ops_admin', 'checkin.read'),
    ('ops_admin', 'checkin.write'),
    ('ops_admin', 'gate.read'),
    ('ops_admin', 'gate.write'),
    ('ops_admin', 'settings.manage'),
    ('ops_admin', 'audit.read'),
    ('ops_admin', 'users.manage'),
    ('ops_admin', 'diagnostics.read')
)
insert into public.app_role_permissions (role_id, permission_key)
select role_id, permission_key
from seeded_permissions
on conflict do nothing;

insert into public.app_role_permissions (role_id, permission_key)
select 'super_admin', unnest(public.app_operator_known_permission_keys())
on conflict do nothing;

insert into public.app_operator_roles (user_id, role_id)
select user_id, 'super_admin'
from public.app_operators
where lower(coalesce(username, '')) = 'admin'
   or lower(coalesce(email, '')) = 'admin@operators.local.ahtops'
on conflict do nothing;

insert into public.app_operator_roles (user_id, role_id)
select operators.user_id, 'ops_admin'
from public.app_operators operators
where not exists (
  select 1
  from public.app_operator_roles existing_roles
  where existing_roles.user_id = operators.user_id
)
on conflict do nothing;

create or replace function public.app_operator_has_permission_for(p_user_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with operator_row as (
    select can_manage_ai, can_use_ai
    from public.app_operators
    where user_id = p_user_id
  )
  select case
    when p_user_id is null then false
    when not exists (select 1 from operator_row) then false
    when exists (
      select 1
      from public.app_operator_permission_overrides overrides
      where overrides.user_id = p_user_id
        and overrides.permission_key = p_permission_key
        and overrides.effect = 'deny'
    ) then false
    when exists (
      select 1
      from public.app_operator_permission_overrides overrides
      where overrides.user_id = p_user_id
        and overrides.permission_key = p_permission_key
        and overrides.effect = 'allow'
    ) then true
    when p_permission_key = 'ai.manage'
      and exists (select 1 from operator_row where can_manage_ai is true)
    then true
    when p_permission_key = 'ai.use'
      and exists (select 1 from operator_row where can_use_ai is true or can_manage_ai is true)
    then true
    when exists (
      select 1
      from public.app_operator_roles roles
      where roles.user_id = p_user_id
        and roles.role_id = 'super_admin'
    ) and p_permission_key = any(public.app_operator_known_permission_keys()) then true
    when exists (
      select 1
      from public.app_operator_roles roles
      join public.app_role_permissions permissions on permissions.role_id = roles.role_id
      where roles.user_id = p_user_id
        and permissions.permission_key = p_permission_key
    ) then true
    else false
  end
$$;

create or replace function public.app_operator_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission_for(auth.uid(), p_permission_key)
$$;

create or replace function public.app_operator_can_use_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission('ai.use')
$$;

create or replace function public.app_operator_can_manage_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission('ai.manage')
$$;

alter table public.app_roles enable row level security;
alter table public.app_role_permissions enable row level security;
alter table public.app_operator_roles enable row level security;
alter table public.app_operator_permission_overrides enable row level security;

drop policy if exists "app operators can read" on public.app_roles;
drop policy if exists "app operators can write" on public.app_roles;
drop policy if exists "app operators can read" on public.app_role_permissions;
drop policy if exists "app operators can write" on public.app_role_permissions;
drop policy if exists "app operators can read" on public.app_operator_roles;
drop policy if exists "app operators can write" on public.app_operator_roles;
drop policy if exists "app operators can read" on public.app_operator_permission_overrides;
drop policy if exists "app operators can write" on public.app_operator_permission_overrides;

create policy "app operators can read" on public.app_roles
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_role_permissions
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_operator_roles
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_operator_permission_overrides
  for select to authenticated
  using (public.is_app_operator());

grant execute on function public.app_operator_known_permission_keys() to authenticated;
grant execute on function public.app_operator_has_permission_for(uuid, text) to authenticated;
grant execute on function public.app_operator_has_permission(text) to authenticated;
grant execute on function public.app_operator_can_use_ai() to authenticated;
grant execute on function public.app_operator_can_manage_ai() to authenticated;
