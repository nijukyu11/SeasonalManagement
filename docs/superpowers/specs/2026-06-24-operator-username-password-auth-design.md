# Operator Username Password Auth Design

## Status

Approved design direction for replacing the visible operator login from email/password to username/password after the self-hosted Supabase cutover.

The implementation keeps Supabase Auth as the real authentication boundary. The user no longer has to know or enter an email address, but the app still receives a normal Supabase session/JWT so existing RLS policies, authenticated RPC grants, Edge Functions, and `auth.uid()` checks keep working.

## Context

The app now targets the self-hosted Supabase endpoint at `https://supabase.ahtops.xyz`. Existing privileged paths intentionally reject anon access and require an authenticated operator session:

- `OperatorAuthGate` signs in through `supabase.auth.signInWithPassword`.
- `public.app_operators.user_id` maps authorized operators to `auth.users.id`.
- RLS and RPC grants use the `authenticated` role plus `public.is_app_operator()` / AI operator helper functions.
- Existing docs record that anon execute is intentionally revoked for privileged write RPCs.

Supabase password auth natively signs in with email or phone identities. Username is therefore a product/UI identifier in this app, not a native Supabase identity type.

## Decision

Use visible `username + password` login, backed by hidden technical email identities in Supabase Auth.

The login form asks for:

- `Username`
- `Password`

The client normalizes the username and derives a technical email:

```text
<username>@operators.local.ahtops
```

Then it calls:

```ts
supabase.auth.signInWithPassword({
  email: technicalEmail,
  password,
});
```

After sign-in, `OperatorAuthGate` still checks `app_operators.user_id = session.user.id`. A valid Supabase Auth user without an `app_operators` row remains unauthorized.

## Why This Approach

This is the smallest safe change:

- Keeps Supabase refresh tokens, access tokens, RLS, Realtime, Edge Function auth, and RPC grants intact.
- Avoids a public pre-login username lookup RPC that could leak valid usernames.
- Avoids a custom password-verification service or service-role login proxy.
- Lets operations create and revoke accounts with the existing Supabase Auth user lifecycle.
- Removes email from the operator-facing login workflow.

## Data Model

Extend `public.app_operators` with non-sensitive operator profile fields:

```sql
alter table public.app_operators
  add column if not exists username text,
  add column if not exists display_name text;

create unique index if not exists app_operators_username_unique
  on public.app_operators (lower(username))
  where username is not null;
```

Field meaning:

- `username`: stable visible login identifier, for example `tuan` or `ops01`.
- `display_name`: optional human-friendly operator name for UI/audit display.
- `email`: retained as the technical email currently associated with the Supabase Auth identity.
- `user_id`: remains the authorization key and must continue to reference `auth.users(id)`.

Do not use `user_metadata` for authorization. Authorization remains table-backed through `app_operators` and `auth.uid()`.

## Username Rules

Normalize username before deriving the technical email:

- trim whitespace
- lowercase
- allow only `a-z`, `0-9`, `_`, `.`, and `-`
- require length `3..32`
- reject leading/trailing punctuation if it creates ambiguous operator names

If the entered value contains `@`, treat it as a temporary compatibility path and pass it as an email unchanged. This fallback is only for existing accounts during migration and can be removed after all operators have usernames.

## Account Provisioning

Operator creation stays admin-controlled. There is no public signup in this scope.

Provisioning flow:

1. Admin creates or updates a Supabase Auth user with technical email `<username>@operators.local.ahtops` and a password.
2. Admin inserts or updates `public.app_operators` with `user_id`, `email`, `username`, `display_name`, and permission flags.
3. Operator signs in with username/password through the desktop app.
4. App verifies the session user has an `app_operators` row before showing operational routes.

Self-hosted Supabase can run without user-facing email confirmation for these technical identities, or accounts can be admin-created as confirmed users. The app should not depend on outbound auth email for this workflow.

## UI Changes

Update `OperatorAuthGate` only as the first UI surface:

- Replace the email field label with `Username`.
- Keep the password field.
- Change helper copy from email/operator account language to username/operator account language.
- Keep busy, unauthorized, sign-out, and session-refresh states.
- Show the authorized operator as `display_name ?? username ?? email`.

Do not redesign the app shell or permission UX in this slice.

## Auth Flow

Normal sign-in:

1. User enters username and password.
2. Client validates and normalizes username.
3. Client derives the technical email.
4. Supabase Auth signs in with email/password.
5. App refreshes the session if needed.
6. App reads `app_operators` by `user_id`.
7. If the row exists, status becomes authorized.
8. If missing, sign-in succeeds at Supabase level but the app shows unauthorized.

Existing session startup stays the same: read stored Supabase session, refresh it against the self-hosted auth server, then check `app_operators`.

## Error Handling

Use generic login errors for bad username/password so the UI does not reveal whether a username exists.

Recommended messages:

- Empty or invalid username: `Username không hợp lệ.`
- Auth failure: `Username hoặc password không đúng.`
- Valid Auth user without operator row: keep a clear operator-access message, but update it to say the account is not enabled for this app.
- Supabase/network failure: show the returned transport/auth message for diagnostics.

## Security

Security boundaries stay unchanged:

- No `service_role` key in the desktop app or frontend bundle.
- No anon execution for privileged write RPCs.
- No username resolver callable before authentication.
- No authorization from user-editable metadata.
- `app_operators.user_id` remains the source of truth for app access.

Password policy is enforced by Supabase Auth configuration. For self-hosted operations, use admin-created accounts and a minimum password standard rather than short PINs.

## Migration Plan

The first implementation should support both new username login and old email login:

- Existing operators can keep signing in with email if they enter an email address.
- New and migrated operators use username.
- Add docs/runbook steps for creating operator users with technical emails.
- After all operators are migrated, remove or hide the email fallback in a later cleanup.

## Testing

Regression coverage should include:

- Username normalization and technical-email derivation.
- Rejection of invalid usernames.
- Email fallback remains available during migration.
- `OperatorAuthGate` calls Supabase password sign-in with the derived email.
- Authorized session still requires an `app_operators` row.
- UI shows display name or username when available.
- Existing self-hosted session storage and refresh behavior still works.
- Schema snapshot includes `username`, `display_name`, and the unique normalized username constraint.

## Out Of Scope

- PIN login.
- Public signup.
- Password reset email UX.
- Full operator management UI.
- Replacing Supabase Auth with a custom auth service.
- Changing RLS/RPC grants away from `authenticated` + `app_operators`.
