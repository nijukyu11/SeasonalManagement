import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const migrationUrl = new URL(
  '../migrations/20260718090000_seasonal_source_import_v2.sql',
  import.meta.url
);
const testUrl = new URL('./seasonal_source_import_v2.sql', import.meta.url);
const bootstrapFixtureSql = `
create table public.app_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  display_name text
);
create table public.app_operator_permission_overrides (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  permission_key text not null,
  effect text not null check (effect in ('allow', 'deny')),
  primary key (user_id, permission_key)
);
create table public.seasons (
  id text primary key,
  season_code text not null,
  name text not null,
  file_name text not null default '',
  uploaded_at bigint not null default 0,
  effective_start text not null default '',
  effective_end text not null default '',
  total_legs integer not null default 0,
  total_source_rows integer not null default 0,
  data_version integer not null default 0
);
create or replace function public.app_operator_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.app_operator_permission_overrides overrides
    where overrides.user_id = auth.uid()
      and overrides.permission_key = p_permission_key
      and overrides.effect = 'allow'
  )
$$;
grant usage on schema public to authenticated;
grant execute on function public.app_operator_has_permission(text) to authenticated;
`;

const db = await createSupabasePGlite();
const startedAt = Date.now();

try {
  await db.exec(bootstrapFixtureSql);
  await db.exec(await readFile(migrationUrl, 'utf8'));
  await db.exec(await readFile(testUrl, 'utf8'));
  console.log(JSON.stringify({
    suite: 'seasonal_source_import_v2.sql',
    engine: 'PGlite',
    elapsedMs: Date.now() - startedAt,
    status: 'passed',
  }));
} finally {
  await db.close();
}
