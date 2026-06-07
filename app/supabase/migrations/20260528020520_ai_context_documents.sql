create table if not exists public.operational_ai_context_documents (
  id text primary key,
  kind text not null check (kind in ('rule', 'skill')),
  title text not null,
  content_md text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

alter table public.operational_ai_context_documents enable row level security;

drop policy if exists "app operators can read" on public.operational_ai_context_documents;
drop policy if exists "app operators can write" on public.operational_ai_context_documents;

create policy "app operators can read"
  on public.operational_ai_context_documents
  for select
  to authenticated
  using (public.is_app_operator());

create policy "app operators can write"
  on public.operational_ai_context_documents
  for all
  to authenticated
  using (public.is_app_operator())
  with check (public.is_app_operator());

grant select, insert, update, delete on public.operational_ai_context_documents to authenticated;
