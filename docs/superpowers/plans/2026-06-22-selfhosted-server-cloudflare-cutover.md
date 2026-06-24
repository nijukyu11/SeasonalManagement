# Self-hosted Server Cloudflare Cutover Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task-by-task. This is a documentation and operational cutover plan only.

**Goal:** Cut SeasonalManagement releases over to the self-hosted Supabase endpoint exposed through Cloudflare Tunnel at `https://supabase.ahtops.xyz`.

**Current scope:** NO-SCHEMA-CHANGE. The self-hosted server is already set up from a cloud server dump. Do not implement app migrations, Supabase migrations, new RPCs, table changes, or local mirror recovery UX in this cutover.

**Architecture:** The signed Tauri app continues to use the existing Supabase client contract through build-time variables. Cloudflare Tunnel exposes the self-hosted Supabase endpoint. SQLite remains the desktop local mirror and native working store. Server-side write hardening is deferred to `docs/handoffs/selfhosted-server-side-write-hardening.md`.

**Tech Stack:** Cloudflare Tunnel, self-hosted Supabase/Postgres, existing Supabase RPCs and Edge Functions, Tauri v2, Next.js/React, Rust SQLite mirror, GitHub Actions release variables.

---

## Cutover Principles

- No schema or RPC changes are part of this cutover.
- Do not run or add files under `app/supabase/migrations/` for this cutover.
- Do not implement `apply_seasonal_import_remote` in this cutover.
- Do not add local mirror recovery UX in this cutover.
- Keep all DB/RPC/schema work in the backend handoff until the endpoint cutover is stable.
- Do not paste the full anon key into repo docs. The anon key is provided out-of-band and stored as a GitHub repository variable.
- Preserve the existing public build contract: `NEXT_PUBLIC_REMOTE_BACKEND`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Rollback must be possible by restoring release variables and shipping a signed rollback build.

## Files In Scope

- Modify: `docs/superpowers/plans/2026-06-22-selfhosted-server-cloudflare-cutover.md`
- Create: `docs/runbooks/selfhosted-cloudflare-cutover.md`
- Create: `docs/handoffs/selfhosted-server-side-write-hardening.md`
- Modify: `context.md`
- Modify: `architecture.md`

## Files Out Of Scope

- `app/supabase/migrations/*`
- `app/supabase/schema.sql`
- `app/src/lib/supabaseStore.ts`
- `app/src/lib/remoteStore.ts`
- `app/src/lib/seasonSync.ts`
- `app/src/app/SeasonalSchedulePage.tsx`
- `app/src/app/components/SeasonSyncProvider.tsx`
- `app/src-tauri/*`

---

### Task 1: Confirm Endpoint Inventory

**Files:**
- Create/update: `docs/runbooks/selfhosted-cloudflare-cutover.md`

- [ ] Record the current production Supabase URL from GitHub repository variables before changing anything.
- [ ] Record only an anon-key fingerprint or ownership note. Never paste the full anon key into docs.
- [ ] Record the target endpoint as `https://supabase.ahtops.xyz`.
- [ ] Confirm the rollback URL and rollback anon-key source are available out-of-band.
- [ ] Confirm Cloudflare Tunnel is the intended public ingress for the self-hosted Supabase API.

Expected: the runbook contains enough operational detail to cut over and roll back without exposing secrets.

### Task 2: Endpoint And Tunnel Smoke

**Files:**
- Create/update: `docs/runbooks/selfhosted-cloudflare-cutover.md`

- [ ] Add health checks for:
  - `GET https://supabase.ahtops.xyz/rest/v1/`
  - `GET https://supabase.ahtops.xyz/auth/v1/health`
  - `OPTIONS https://supabase.ahtops.xyz/functions/v1/dashboard-ai-analysis`
  - `POST https://supabase.ahtops.xyz/rest/v1/rpc/get_season_change_event_page` with a known season id placeholder.
- [ ] Document that Cloudflare must return API responses, not an Access login page, challenge page, 502, or 1033.
- [ ] Document that `/rest/v1/*`, `/auth/v1/*`, `/realtime/v1/*`, `/storage/v1/*` if used, and `/functions/v1/*` must remain callable by the desktop app.

Expected: operators can smoke the tunnel and Supabase API surface before building a release.

### Task 3: Build With Self-hosted Release Variables

**Files:**
- Create/update: `docs/runbooks/selfhosted-cloudflare-cutover.md`

- [ ] Document local build variables:

```powershell
$env:NEXT_PUBLIC_REMOTE_BACKEND = "supabase"
$env:NEXT_PUBLIC_SUPABASE_URL = "https://supabase.ahtops.xyz"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "<provided-out-of-band>"
```

- [ ] Document GitHub repository variables:
  - `NEXT_PUBLIC_REMOTE_BACKEND=supabase`
  - `NEXT_PUBLIC_SUPABASE_URL=https://supabase.ahtops.xyz`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` set from the provided out-of-band anon key.
- [ ] State that existing installed clients continue using the endpoint compiled into their current bundle until they update.
- [ ] Run or document the expected build checks from the existing release workflow, without adding new schema steps.

Expected: a staging or production signed build can be produced using only environment/repository variable changes.

### Task 4: Staging Desktop Smoke

**Files:**
- Create/update: `docs/runbooks/selfhosted-cloudflare-cutover.md`

- [ ] Install the staging build on a test workstation.
- [ ] Smoke:
  - App opens.
  - Login/session refresh works.
  - Season list loads from `https://supabase.ahtops.xyz`.
  - `Fetch Server Updates` returns no updates or applies expected events.
  - Save sends pending changes through the existing `sync_season_workspace_v2` path.
  - Dashboard and AI reporting paths do not hit the old hosted URL.
  - Edge Functions respond through `/functions/v1/*`.
  - App restart preserves the SQLite mirror.

Expected: the endpoint switch is validated without requiring DB/RPC/schema changes.

### Task 5: Production Cutover And Rollback

**Files:**
- Create/update: `docs/runbooks/selfhosted-cloudflare-cutover.md`

- [ ] Document the production variable update.
- [ ] Document the signed release trigger.
- [ ] Document post-release monitoring for tunnel health, auth refresh, RPC responses, Edge Function responses, and client error reports.
- [ ] Document rollback decision points.
- [ ] Document rollback by restoring the prior Supabase URL/anon-key GitHub variables and shipping a signed rollback build.

Expected: production cutover has a reversible operational path.

### Task 6: Backend Handoff For Deferred Work

**Files:**
- Create: `docs/handoffs/selfhosted-server-side-write-hardening.md`

- [ ] Move all DB/RPC/schema work into the backend handoff:
  - transactional import/re-import RPC
  - `sync_season_workspace_v2` hardening and `changedTargets`
  - local mirror recovery support if DB state is required
  - integrity SQL
  - RLS/security review
- [ ] Mark the handoff as not part of this cutover.
- [ ] Schedule it only after endpoint cutover is stable.

Expected: future backend hardening is retained without expanding the current cutover.

### Task 7: Documentation Finalization

**Files:**
- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `docs/runbooks/selfhosted-cloudflare-cutover.md`
- Modify: `docs/handoffs/selfhosted-server-side-write-hardening.md`

- [ ] Add a short note that this cutover uses Cloudflare Tunnel and self-hosted Supabase as the endpoint.
- [ ] Add a short note that this cutover is no-schema-change.
- [ ] Add a short note that SQLite remains the local mirror.
- [ ] Add a short note that server-side write hardening is deferred to the backend handoff.

Expected: durable project docs reflect the chosen cutover boundary.

---

## Verification

Run from `C:\Users\tuan\Documents\SeasonalManagement`:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$files = @(
  "docs/superpowers/plans/2026-06-22-selfhosted-server-cloudflare-cutover.md",
  "docs/runbooks/selfhosted-cloudflare-cutover.md",
  "docs/handoffs/selfhosted-server-side-write-hardening.md",
  "context.md",
  "architecture.md"
)
$markers = @([char]0x00C3, [char]0x00C2, "$([char]0x00E1)$([char]0x00BA)", [char]0x00C6, [char]0x00C4, [char]0xFFFD)
$pattern = ($markers | ForEach-Object { [regex]::Escape($_) }) -join "|"
rg -n $pattern $files

git diff -- docs/superpowers/plans/2026-06-22-selfhosted-server-cloudflare-cutover.md docs/runbooks/selfhosted-cloudflare-cutover.md docs/handoffs/selfhosted-server-side-write-hardening.md context.md architecture.md
```

Expected:

- Mojibake scan returns no matches.
- Diff contains only the requested documentation scope.
- No files under `app/supabase/`, `app/src/`, or `app/src-tauri/` are changed by this cutover.

## Later Phase

After the endpoint cutover is stable, execute `docs/handoffs/selfhosted-server-side-write-hardening.md` as a separate backend hardening scope. That later phase may include migrations, RPC implementation, schema snapshots, and app code changes, but none of those belong to this no-schema endpoint cutover.
