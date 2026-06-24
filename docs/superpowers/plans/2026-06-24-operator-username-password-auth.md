# Operator Username Password Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible operator login with username/password while keeping Supabase Auth, JWT refresh, RLS, authenticated RPC grants, and `app_operators.user_id = auth.uid()` unchanged.

**Architecture:** Add a small pure TypeScript identity helper that maps visible usernames to hidden technical Supabase email identities. Extend `app_operators` with `username` and `display_name`, then update `OperatorAuthGate` and the sidebar to display operator profile data without introducing a pre-login username lookup or a custom auth service.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase JS v2, Supabase Auth, Postgres migrations, Node test runner with `--experimental-strip-types`.

---

## File Structure

- Create `app/src/lib/operatorAuthIdentity.ts`
  - Owns username validation, normalization, technical-email derivation, email fallback handling, and operator display label resolution.
- Create `app/src/lib/operatorAuthIdentity.test.ts`
  - Unit tests for pure auth identity logic.
- Modify `app/src/app/components/OperatorAuthGate.tsx`
  - Switch visible form from email to username, call the helper before Supabase sign-in, load `username` / `display_name` from `app_operators`, and expose a richer operator profile through context.
- Modify `app/src/app/components/AppSidebar.tsx`
  - Display `display_name ?? username ?? email ?? Operator` and use the same label in the collapsed sign-out title.
- Modify `app/src/lib/supabaseStore.ts`
  - Resolve current remote actor display data from `app_operators` so audit entries can show the app operator name when available.
- Create a Supabase migration with `npx supabase migration new operator_username_login`
  - Adds `username`, `display_name`, and a unique normalized username index to `public.app_operators`.
  - Do not hand-invent the migration filename; use the CLI-generated file.
- Modify `app/supabase/schema.sql`
  - Keep the schema snapshot aligned with the migration.
- Modify `app/src/lib/seasonalImportModeGuard.test.ts`
  - Extend source-level guard coverage for the self-hosted auth cutover and username-login helpers.
- Create `docs/runbooks/operator-username-password-auth.md`
  - Documents admin account provisioning with technical emails.
- Modify `context.md`
  - Record the chosen username/password design as current project context.

---

### Task 1: Add Pure Operator Auth Identity Helper

**Files:**
- Create: `app/src/lib/operatorAuthIdentity.ts`
- Create: `app/src/lib/operatorAuthIdentity.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `app/src/lib/operatorAuthIdentity.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_TECHNICAL_EMAIL_DOMAIN,
  formatOperatorLabel,
  normalizeOperatorUsername,
  resolveOperatorLoginIdentity,
} from './operatorAuthIdentity.ts';

test('normalizes a visible username into the technical Supabase email identity', () => {
  assert.equal(normalizeOperatorUsername(' Ops_01 '), 'ops_01');
  assert.deepEqual(resolveOperatorLoginIdentity(' Ops_01 '), {
    kind: 'username',
    username: 'ops_01',
    email: `ops_01@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`,
  });
});

test('rejects invalid operator usernames before calling Supabase Auth', () => {
  assert.throws(() => resolveOperatorLoginIdentity('ab'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('-ops'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops-'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops vn'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops@'), /Username không hợp lệ/);
});

test('keeps email fallback available during migration', () => {
  assert.deepEqual(resolveOperatorLoginIdentity(' Ops@Example.COM '), {
    kind: 'email',
    username: null,
    email: 'ops@example.com',
  });
});

test('formats operator labels without exposing technical email when profile data exists', () => {
  assert.equal(formatOperatorLabel({ displayName: 'Nguyen Van A', username: 'ops01', email: 'ops01@operators.local.ahtops' }), 'Nguyen Van A');
  assert.equal(formatOperatorLabel({ displayName: null, username: 'ops01', email: 'ops01@operators.local.ahtops' }), 'ops01');
  assert.equal(formatOperatorLabel({ displayName: null, username: null, email: 'ops01@operators.local.ahtops' }), 'ops01@operators.local.ahtops');
  assert.equal(formatOperatorLabel({ displayName: null, username: null, email: null }), 'Operator');
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run from `C:\Users\tuan\Documents\SeasonalManagement\app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/operatorAuthIdentity.test.ts
```

Expected: FAIL with a module-not-found error for `operatorAuthIdentity.ts`.

- [ ] **Step 3: Implement the helper**

Create `app/src/lib/operatorAuthIdentity.ts`:

```ts
export const OPERATOR_TECHNICAL_EMAIL_DOMAIN = 'operators.local.ahtops';

export type OperatorLoginIdentity =
  | {
      kind: 'username';
      username: string;
      email: string;
    }
  | {
      kind: 'email';
      username: null;
      email: string;
    };

export type OperatorProfile = {
  email: string | null;
  username: string | null;
  displayName: string | null;
};

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_USERNAME_MESSAGE = 'Username không hợp lệ.';

export function normalizeOperatorUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new Error(INVALID_USERNAME_MESSAGE);
  return username;
}

function normalizeOperatorEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error(INVALID_USERNAME_MESSAGE);
  return email;
}

export function operatorUsernameToTechnicalEmail(username: string): string {
  return `${normalizeOperatorUsername(username)}@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`;
}

export function resolveOperatorLoginIdentity(value: string): OperatorLoginIdentity {
  const trimmed = value.trim();
  if (trimmed.includes('@')) {
    return {
      kind: 'email',
      username: null,
      email: normalizeOperatorEmail(trimmed),
    };
  }

  const username = normalizeOperatorUsername(trimmed);
  return {
    kind: 'username',
    username,
    email: `${username}@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`,
  };
}

export function formatOperatorLabel(profile: OperatorProfile): string {
  const displayName = profile.displayName?.trim();
  if (displayName) return displayName;
  const username = profile.username?.trim();
  if (username) return username;
  const email = profile.email?.trim();
  if (email) return email;
  return 'Operator';
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/operatorAuthIdentity.test.ts
```

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit Task 1**

```powershell
git add app/src/lib/operatorAuthIdentity.ts app/src/lib/operatorAuthIdentity.test.ts
git commit -m "feat: add operator username identity helper"
```

---

### Task 2: Add Operator Username Schema Fields

**Files:**
- Create with CLI: `app/supabase/migrations/*_operator_username_login.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Write the failing schema source guard**

In `app/src/lib/seasonalImportModeGuard.test.ts`, add a new test below `Supabase auth survives self-hosted cutover storage and JWT refresh`:

```ts
test('app operator schema supports username login metadata without changing auth uid authorization', () => {
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(schemaSource, /username text/);
  assert.match(schemaSource, /display_name text/);
  assert.match(schemaSource, /app_operators_username_unique/);
  assert.match(schemaSource, /where username is not null/);
  assert.match(schemaSource, /where user_id = auth\.uid\(\)/);
});
```

- [ ] **Step 2: Run the source guard and verify it fails**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because `schema.sql` does not yet contain the username-login schema markers.

- [ ] **Step 3: Generate the Supabase migration file**

Run from `app`:

```powershell
npx supabase migration new operator_username_login
```

Expected: Supabase CLI prints the new file path under `app/supabase/migrations/`. Use that generated file in the next step. If the Supabase CLI is unavailable, stop and report the missing CLI instead of hand-creating the migration filename.

- [ ] **Step 4: Fill the generated migration**

Replace the CLI-generated migration contents with:

```sql
alter table public.app_operators
  add column if not exists username text,
  add column if not exists display_name text;

create unique index if not exists app_operators_username_unique
  on public.app_operators (lower(username))
  where username is not null;
```

- [ ] **Step 5: Update the schema snapshot**

In `app/supabase/schema.sql`, update the `public.app_operators` table definition to include the new nullable columns:

```sql
create table if not exists public.app_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  display_name text,
  can_manage_ai boolean not null default false,
  can_use_ai boolean not null default true,
  created_at timestamptz not null default now()
);
```

Then add the unique normalized username index after the `app_operators` column maintenance block:

```sql
alter table public.app_operators
  add column if not exists username text,
  add column if not exists display_name text;

create unique index if not exists app_operators_username_unique
  on public.app_operators (lower(username))
  where username is not null;
```

- [ ] **Step 6: Run the source guard and verify the schema assertions pass**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: the schema assertions pass and `seasonalImportModeGuard.test.ts` exits 0.

- [ ] **Step 7: Commit Task 2**

Stage only the generated migration, schema snapshot, and source guard:

```powershell
$MigrationPath = (Get-ChildItem app/supabase/migrations -Filter '*_operator_username_login.sql' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
git add -- $MigrationPath app/supabase/schema.sql app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: add operator username schema"
```

---

### Task 3: Switch OperatorAuthGate To Username Password Login

**Files:**
- Modify: `app/src/app/components/OperatorAuthGate.tsx`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Add failing UI/auth source guard markers**

In `app/src/lib/seasonalImportModeGuard.test.ts`, extend the existing `Supabase auth survives self-hosted cutover storage and JWT refresh` test with these assertions:

```ts
  assert.match(authGateSource, /resolveOperatorLoginIdentity/);
  assert.match(authGateSource, /username,display_name/);
  assert.match(authGateSource, /operatorLabel/);
```

- [ ] **Step 2: Confirm the source guard fails for UI markers**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL on `resolveOperatorLoginIdentity`, `username,display_name`, or `operatorLabel` markers.

- [ ] **Step 3: Import the auth identity helper**

In `app/src/app/components/OperatorAuthGate.tsx`, add this import:

```ts
import {
  formatOperatorLabel,
  type OperatorProfile,
  resolveOperatorLoginIdentity,
} from '@/lib/operatorAuthIdentity';
```

- [ ] **Step 4: Expand the context shape**

Replace `OperatorAuthContextValue` and the default context value with:

```ts
type OperatorAuthContextValue = {
  enabled: boolean;
  email: string | null;
  username: string | null;
  displayName: string | null;
  operatorLabel: string;
  signingOut: boolean;
  signOut: () => Promise<void>;
};

const EMPTY_OPERATOR_PROFILE: OperatorProfile = {
  email: null,
  username: null,
  displayName: null,
};

const OperatorAuthContext = createContext<OperatorAuthContextValue>({
  enabled: false,
  email: null,
  username: null,
  displayName: null,
  operatorLabel: 'Operator',
  signingOut: false,
  signOut: async () => {},
});
```

- [ ] **Step 5: Rename the form input from email to username**

Inside `OperatorAuthScreen`, change the `onSubmit` prop and local state:

```ts
  onSubmit: (username: string, password: string) => Promise<void>;
```

```ts
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(username, password);
  }, [onSubmit, password, username]);
```

Replace the email field JSX with:

```tsx
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-200">Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              className="operator-auth-control h-11 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-300"
              placeholder="ops01"
            />
          </label>
```

Change the helper copy to:

```tsx
          <p className="mt-1 text-sm text-slate-400">Sign in with your operator username</p>
```

- [ ] **Step 6: Store an operator profile instead of email-only state**

In the component state, replace:

```ts
  const [email, setEmail] = useState<string | null>(null);
```

with:

```ts
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>(EMPTY_OPERATOR_PROFILE);
```

In `refreshSession`, replace the no-session branch with:

```ts
    if (!session?.user) {
      setOperatorProfile(EMPTY_OPERATOR_PROFILE);
      setStatus('signedOut');
      return;
    }
```

Replace the `app_operators` query with:

```ts
      .from('app_operators')
      .select('user_id,email,username,display_name')
      .eq('user_id', session.user.id)
      .maybeSingle();
```

Replace the error and missing-row profile assignments with:

```ts
      setOperatorProfile({
        email: session.user.email ?? null,
        username: null,
        displayName: null,
      });
```

Replace the successful profile assignment with:

```ts
    setOperatorProfile({
      email: data.email ?? session.user.email ?? null,
      username: typeof data.username === 'string' ? data.username : null,
      displayName: typeof data.display_name === 'string' ? data.display_name : null,
    });
```

- [ ] **Step 7: Add generic credential errors without hiding transport failures**

Add this helper near the top-level functions in `OperatorAuthGate.tsx`:

```ts
function formatOperatorSignInErrorMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials') || normalized.includes('email not confirmed')) {
    return 'Username hoặc password không đúng.';
  }
  return message || 'Không đăng nhập được. Vui lòng thử lại.';
}
```

- [ ] **Step 8: Use username resolution during sign-in**

Replace the `signIn` callback with:

```ts
  const signIn = useCallback(async (loginName: string, password: string) => {
    setBusy(true);
    setErrorMessage(null);

    try {
      const identity = resolveOperatorLoginIdentity(loginName);
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: identity.email,
        password,
      });
      if (error) {
        setErrorMessage(formatOperatorSignInErrorMessage(error.message));
        setStatus('signedOut');
        return;
      }
      await refreshSession(data.session);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Username không hợp lệ.');
      setStatus('signedOut');
    } finally {
      setBusy(false);
    }
  }, [refreshSession]);
```

- [ ] **Step 9: Reset operator profile on sign-out**

Inside `signOut`, replace:

```ts
      setEmail(null);
```

with:

```ts
      setOperatorProfile(EMPTY_OPERATOR_PROFILE);
```

- [ ] **Step 10: Publish the richer context value**

Replace the `contextValue` memo with:

```ts
  const operatorLabel = useMemo(() => formatOperatorLabel(operatorProfile), [operatorProfile]);

  const contextValue = useMemo<OperatorAuthContextValue>(() => ({
    enabled,
    email: operatorProfile.email,
    username: operatorProfile.username,
    displayName: operatorProfile.displayName,
    operatorLabel,
    signingOut,
    signOut,
  }), [enabled, operatorLabel, operatorProfile, signOut, signingOut]);
```

- [ ] **Step 11: Update unauthorized copy**

In the unauthorized state, replace:

```tsx
                Operator access is not enabled for this account. Add this Auth user to public.app_operators, then sign in again.
```

with:

```tsx
                Operator access is not enabled for this account. Add this Auth user to public.app_operators with a username, then sign in again.
```

- [ ] **Step 12: Run focused tests**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/operatorAuthIdentity.test.ts
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: both commands pass.

- [ ] **Step 13: Commit Task 3**

```powershell
git add app/src/app/components/OperatorAuthGate.tsx app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: use username password operator login"
```

---

### Task 4: Display Operator Profile In Sidebar And Audit Actor

**Files:**
- Modify: `app/src/app/components/AppSidebar.tsx`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

- [ ] **Step 1: Add source guard coverage**

Add this test to `app/src/lib/seasonalImportModeGuard.test.ts`:

```ts
test('operator display uses app profile username and display name when available', () => {
  const sidebarSource = readFileSync(join(root, 'app', 'components', 'AppSidebar.tsx'), 'utf8');
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  assert.match(sidebarSource, /operatorAuth\.operatorLabel/);
  assert.match(supabaseStoreSource, /username,display_name/);
  assert.match(supabaseStoreSource, /operator\?\.display_name/);
  assert.match(supabaseStoreSource, /user_metadata\?\.full_name \?\? username/);
});
```

- [ ] **Step 2: Run the source guard and verify it fails**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because the sidebar and audit actor still use email/user metadata only.

- [ ] **Step 3: Update sidebar display**

In `app/src/app/components/AppSidebar.tsx`, replace the collapsed title:

```tsx
              title={operatorAuth.email ? `Sign out ${operatorAuth.email}` : 'Sign out'}
```

with:

```tsx
              title={`Sign out ${operatorAuth.operatorLabel}`}
```

Replace the expanded operator text:

```tsx
                  {operatorAuth.email ?? 'Operator'}
```

with:

```tsx
                  {operatorAuth.operatorLabel}
```

- [ ] **Step 4: Update audit actor profile resolution**

In `app/src/lib/supabaseStore.ts`, replace `getCurrentRemoteActor()` with:

```ts
  async getCurrentRemoteActor(): Promise<RemoteActor | null> {
    const { data } = await getSupabaseClient().auth.getUser();
    const user = data.user;
    if (!user) return null;

    const { data: operator } = await getSupabaseClient()
      .from('app_operators')
      .select('email,username,display_name')
      .eq('user_id', user.id)
      .maybeSingle();

    const email = typeof operator?.email === 'string' ? operator.email : user.email ?? null;
    const username = typeof operator?.username === 'string' ? operator.username : null;
    const displayName = typeof operator?.display_name === 'string'
      ? operator.display_name
      : user.user_metadata?.name ?? user.user_metadata?.full_name ?? username;

    return {
      uid: user.id,
      email,
      displayName,
      isAnonymous: user.is_anonymous ?? false,
    };
  },
```

- [ ] **Step 5: Run focused tests**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add app/src/app/components/AppSidebar.tsx app/src/lib/supabaseStore.ts app/src/lib/seasonalImportModeGuard.test.ts
git commit -m "feat: show operator profile labels"
```

---

### Task 5: Document Operator Provisioning And Current Auth Decision

**Files:**
- Create: `docs/runbooks/operator-username-password-auth.md`
- Modify: `context.md`

- [ ] **Step 1: Create the provisioning runbook**

Create `docs/runbooks/operator-username-password-auth.md`:

```md
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
```

- [ ] **Step 2: Update context**

In `context.md`, add this bullet near the existing self-hosted auth cutover status:

```md
- Operator username/password auth direction, 2026-06-24: the visible login should use `username + password`, but Supabase Auth remains the authentication boundary. Usernames map to hidden technical emails under `operators.local.ahtops`, `app_operators.user_id = auth.uid()` remains the authorization key, and the app keeps temporary full-email fallback only for account migration.
```

- [ ] **Step 3: Scan Vietnamese and non-ASCII docs for mojibake**

Run from repo root:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Select-String -Path 'context.md','docs\runbooks\operator-username-password-auth.md' -Pattern 'Ã|Â|áº|Æ|Ä|�' -Encoding UTF8
```

Expected: no matches.

- [ ] **Step 4: Commit Task 5**

```powershell
git add context.md docs/runbooks/operator-username-password-auth.md
git commit -m "docs: document operator username provisioning"
```

---

### Task 6: Final Verification

**Files:**
- Verify all changed files from Tasks 1-5.

- [ ] **Step 1: Run focused auth and source tests**

Run from `app`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
node --experimental-strip-types --test src/lib/operatorAuthIdentity.test.ts
node --experimental-strip-types --test src/lib/seasonalImportModeGuard.test.ts
```

Expected: both commands pass.

- [ ] **Step 2: Run TypeScript check**

Run from `app`:

```powershell
npx tsc --noEmit --pretty false
```

Expected: exit code 0.

- [ ] **Step 3: Run production build**

Run from `app`:

```powershell
npm run build
```

Expected: exit code 0.

- [ ] **Step 4: Run whitespace and mojibake checks**

Run from repo root:

```powershell
git diff --check
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Select-String -Path 'app\src\lib\operatorAuthIdentity.ts','app\src\lib\operatorAuthIdentity.test.ts','app\src\app\components\OperatorAuthGate.tsx','app\src\app\components\AppSidebar.tsx','app\src\lib\supabaseStore.ts','app\src\lib\seasonalImportModeGuard.test.ts','app\supabase\schema.sql','context.md','docs\runbooks\operator-username-password-auth.md' -Pattern 'Ã|Â|áº|Æ|Ä|�' -Encoding UTF8
```

Expected: `git diff --check` exits 0 and mojibake scan prints no matches.

- [ ] **Step 5: Inspect staged scope before final commit**

Run from repo root:

```powershell
git status --short
git diff --stat
```

Expected: only files from this plan are changed relative to the task branch. If unrelated pre-existing dirty files remain, do not stage them.

- [ ] **Step 6: Commit verification cleanup if any**

If final fixes were needed after Task 5, commit only those files:

```powershell
$MigrationPath = (Get-ChildItem app/supabase/migrations -Filter '*_operator_username_login.sql' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
git add -- app/src/lib/operatorAuthIdentity.ts app/src/lib/operatorAuthIdentity.test.ts app/src/app/components/OperatorAuthGate.tsx app/src/app/components/AppSidebar.tsx app/src/lib/supabaseStore.ts app/src/lib/seasonalImportModeGuard.test.ts app/supabase/schema.sql $MigrationPath docs/runbooks/operator-username-password-auth.md context.md
git commit -m "test: verify operator username auth"
```

Expected: no commit is needed if Tasks 1-5 already produced passing verification and no further edits.
