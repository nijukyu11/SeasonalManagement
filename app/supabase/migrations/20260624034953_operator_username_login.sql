alter table public.app_operators
  add column if not exists username text,
  add column if not exists display_name text;

create unique index if not exists app_operators_username_unique
  on public.app_operators (lower(username))
  where username is not null;
