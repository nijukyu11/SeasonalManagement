# Operator Username Password Auth Runbook

## Purpose

SeasonalManagement shows username/password login to operators while keeping Supabase Auth as the real authentication boundary.

The visible username maps to a technical Supabase Auth email:

```text
<username>@operators.local.ahtops
```

## Provision A New Operator

1. Create or update a Supabase Auth user on the self-hosted Supabase server.
2. Use the technical email for the Auth identity, for example `ops01@operators.local.ahtops`.
3. Set a normal password. Do not use a short PIN as the account password.
4. Confirm the Auth user if email confirmation is enabled.
5. Insert or update `public.app_operators` by resolving the Auth user id from the technical email.

```sql
with target_user as (
  select id
  from auth.users
  where email = 'ops01@operators.local.ahtops'
)
insert into public.app_operators (
  user_id,
  email,
  username,
  display_name,
  can_manage_ai,
  can_use_ai
) select
  id,
  'ops01@operators.local.ahtops',
  'ops01',
  'Ops 01',
  false,
  true
from target_user
on conflict (user_id) do update
set email = excluded.email,
    username = excluded.username,
    display_name = excluded.display_name,
    can_manage_ai = excluded.can_manage_ai,
    can_use_ai = excluded.can_use_ai;
```

## Operator Login

Operators enter:

- Username: `ops01`
- Password: the Supabase Auth password

The app derives `ops01@operators.local.ahtops`, signs in through Supabase Auth, refreshes the self-hosted session, then checks `public.app_operators.user_id = auth.uid()`.

## Temporary Email Fallback

During migration, existing operators can still type a full email address into the username field. The app passes email-looking values directly to Supabase Auth. Remove this fallback only after all operators have usernames and technical emails.

## Security Notes

- Do not add a public username lookup endpoint.
- Do not put a `service_role` key in the app bundle.
- Do not authorize from `user_metadata`.
- Keep privileged RPCs limited to `authenticated` plus the existing `app_operators` checks.
