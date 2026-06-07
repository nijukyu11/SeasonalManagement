alter table public.app_operators
  add column if not exists can_use_ai boolean not null default false;

update public.app_operators
set can_use_ai = true
where can_manage_ai is true
  and can_use_ai is false;

create table if not exists public.operational_ai_provider_keys (
  provider text primary key check (provider in ('gemini', 'openai-compatible', 'deepseek')),
  secret_value text not null,
  key_fingerprint text not null,
  updated_at bigint not null default 0,
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.operational_ai_provider_keys enable row level security;

create or replace function public.app_operator_can_use_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_operators
    where user_id = auth.uid()
      and (can_use_ai is true or can_manage_ai is true)
  )
$$;

create or replace function public.app_operator_can_manage_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_operators
    where user_id = auth.uid()
      and can_manage_ai is true
  )
$$;

drop policy if exists "app operators can read" on public.operational_ai_provider_keys;
drop policy if exists "app operators can write" on public.operational_ai_provider_keys;
drop policy if exists "ai users can read provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can insert provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can update provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can delete provider keys" on public.operational_ai_provider_keys;

create policy "ai users can read provider keys"
  on public.operational_ai_provider_keys
  for select
  to authenticated
  using (public.app_operator_can_use_ai());

create policy "ai managers can insert provider keys"
  on public.operational_ai_provider_keys
  for insert
  to authenticated
  with check (public.app_operator_can_manage_ai());

create policy "ai managers can update provider keys"
  on public.operational_ai_provider_keys
  for update
  to authenticated
  using (public.app_operator_can_manage_ai())
  with check (public.app_operator_can_manage_ai());

create policy "ai managers can delete provider keys"
  on public.operational_ai_provider_keys
  for delete
  to authenticated
  using (public.app_operator_can_manage_ai());

grant select, insert, update, delete on public.operational_ai_provider_keys to authenticated;
grant execute on function public.app_operator_can_use_ai() to authenticated;
grant execute on function public.app_operator_can_manage_ai() to authenticated;
