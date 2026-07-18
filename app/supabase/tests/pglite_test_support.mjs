import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const supabaseBootstrapSql = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz
);
create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create publication supabase_realtime;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
`;

export async function createSupabasePGlite() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(supabaseBootstrapSql);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
