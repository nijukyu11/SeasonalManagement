# Self-hosted Cloudflare Cutover Runbook

This runbook covers the no-schema cutover from the current Supabase endpoint to the self-hosted Supabase endpoint exposed through Cloudflare Tunnel.

Target endpoint:

```text
https://supabase.ahtops.xyz
```

The anon key is provided out-of-band and stored as a GitHub repository variable. Do not paste the full anon key into repo docs.

## Scope

This cutover changes endpoint and release configuration only.

In scope:

- Cloudflare Tunnel and endpoint health smoke.
- App build using environment variables.
- GitHub repository variable updates.
- Signed staging and production release smoke.
- Rollback through release variables and signed rollback build.
- Documentation of deferred backend work.

Out of scope:

- Supabase migrations.
- `app/supabase/schema.sql` changes.
- New RPC implementation such as `apply_seasonal_import_remote`.
- App code changes to import/re-import, save, catch-up, or local mirror recovery UX.
- Any direct DB/RPC/schema change on the self-hosted server during this cutover.

## Endpoint Inventory

| Name | Value | Owner | Verification |
| --- | --- | --- | --- |
| Current Supabase URL | Record from GitHub variable `NEXT_PUBLIC_SUPABASE_URL` before cutover | Release operator | GitHub repository variables |
| Current anon key | Record fingerprint only; full key stays out-of-band | Release operator | GitHub repository variables |
| Target Supabase URL | `https://supabase.ahtops.xyz` | Infrastructure operator | Cloudflare Tunnel and HTTPS health checks |
| Target anon key | Provided out-of-band; store only in GitHub variable | Database operator | Self-hosted Supabase dashboard or configured secret source |
| Rollback Supabase URL | The current production URL recorded before cutover | Release operator | GitHub repository variables |
| Rollback anon key | Provided out-of-band; store only in GitHub variable during rollback | Release operator | GitHub repository variables |

## Preconditions

- Self-hosted Supabase is already restored from the cloud server dump.
- The restored database schema is treated as current for this cutover.
- Cloudflare Tunnel routes `https://supabase.ahtops.xyz` to the self-hosted Supabase API surface.
- GitHub repository variables can be updated by the release operator.
- The release workflow still validates the required public build variables.
- Rollback URL and rollback anon key are available out-of-band before the production release starts.

## Cloudflare Access Rule

Do not protect Supabase app API paths with an interactive Cloudflare Access login page unless the desktop app is explicitly updated to supply service-token headers.

Paths that must remain API-callable by the Tauri app:

- `/rest/v1/*`
- `/auth/v1/*`
- `/realtime/v1/*`
- `/storage/v1/*` if storage is used
- `/functions/v1/*`

If Cloudflare Access is enabled later, use a non-interactive API adapter or service-token-aware client change in a separate implementation scope. The current cutover keeps direct Supabase client calls.

## Endpoint Health Checks

Run from a machine outside the server LAN.

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$base = "https://supabase.ahtops.xyz"
$anon = $env:SEASONAL_SELFHOSTED_SUPABASE_ANON_KEY
$headers = @{
  "apikey" = $anon
  "Authorization" = "Bearer $anon"
}

Invoke-WebRequest "$base/rest/v1/" -Headers $headers -UseBasicParsing
Invoke-WebRequest "$base/auth/v1/health" -UseBasicParsing
Invoke-WebRequest "$base/functions/v1/dashboard-ai-analysis" -Method Options -UseBasicParsing
```

Expected:

- `/rest/v1/` returns an HTTP response from Supabase, not a Cloudflare 502/1033/Access page.
- `/auth/v1/health` responds through the tunnel.
- `/functions/v1/dashboard-ai-analysis` `OPTIONS` responds through the tunnel and returns CORS-compatible headers for the app.

Check for interactive Cloudflare challenge text:

```powershell
$response = Invoke-WebRequest "$base/rest/v1/" -Headers $headers -UseBasicParsing
$response.Content | Select-String -Pattern "cloudflareaccess|cf_chl|Just a moment|Access"
```

Expected: no match for interactive challenge or Access login content.

## RPC Smoke

Use a known season id from the restored self-hosted database. Keep the anon key out of docs.

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$base = "https://supabase.ahtops.xyz"
$anon = $env:SEASONAL_SELFHOSTED_SUPABASE_ANON_KEY
$knownSeasonId = "<known-season-id>"
$headers = @{
  "apikey" = $anon
  "Authorization" = "Bearer $anon"
  "Content-Type" = "application/json"
}

Invoke-RestMethod "$base/rest/v1/rpc/get_season_change_event_page" `
  -Method Post `
  -Headers $headers `
  -Body (@{
    p_season_id = $knownSeasonId
    p_after_seq = 0
    p_through_seq = 1
    p_limit = 1
  } | ConvertTo-Json -Compress)
```

Expected: JSON is returned from the self-hosted server. Empty event pages are acceptable for a quiet known season; transport errors, HTML challenge pages, auth failures for a valid key, and Cloudflare 502/1033 responses are not acceptable.

## Local Build Variables

For a local staging build against the tunnel:

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
$env:NEXT_PUBLIC_REMOTE_BACKEND = "supabase"
$env:NEXT_PUBLIC_SUPABASE_URL = "https://supabase.ahtops.xyz"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = $env:SEASONAL_SELFHOSTED_SUPABASE_ANON_KEY
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
```

Expected: all commands pass using the self-hosted endpoint variables. This does not apply migrations or modify schema.

## GitHub Repository Variables

Set these for the staging release first, then production after staging smoke passes:

```text
NEXT_PUBLIC_REMOTE_BACKEND=supabase
NEXT_PUBLIC_SUPABASE_URL=https://supabase.ahtops.xyz
NEXT_PUBLIC_SUPABASE_ANON_KEY=<provided-out-of-band>
```

Operational notes:

- Store the anon key only as a GitHub variable or secret according to the existing workflow contract.
- Do not paste the full anon key into issues, PRs, docs, screenshots, or chat transcripts.
- Existing installed clients continue using the endpoint compiled into their current bundle until they update.

## Staging Desktop Smoke

Install the signed staging build on a test workstation.

Smoke checklist:

- App opens.
- Login/session refresh works.
- Season list loads from `https://supabase.ahtops.xyz`.
- `Fetch Server Updates` returns `No server updates found` or applies expected events.
- Save sends pending changes through the existing `sync_season_workspace_v2` path.
- Dashboard and AI reporting paths do not hit the old hosted URL.
- Edge Functions respond through `/functions/v1/*`.
- App restart preserves the SQLite mirror.
- No Cloudflare Access or challenge HTML appears in client/network errors.

## Production Cutover

1. Confirm endpoint health checks still pass.
2. Confirm rollback URL and rollback anon key are available out-of-band.
3. Set production GitHub repository variables:
   - `NEXT_PUBLIC_REMOTE_BACKEND=supabase`
   - `NEXT_PUBLIC_SUPABASE_URL=https://supabase.ahtops.xyz`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<provided-out-of-band>`
4. Trigger the existing signed release workflow.
5. Install the production release on a test workstation.
6. Repeat the staging smoke checklist.
7. Monitor tunnel, auth, RPC, Edge Function, and client error reports through the cutover window.

## Rollback Decision Points

Rollback if any of these occur during the cutover window:

- Cloudflare Tunnel returns intermittent 502/1033 for Supabase API paths.
- `/rest/v1/`, `/auth/v1/health`, or `/functions/v1/*` return HTML challenge or Access login pages.
- Auth/session refresh fails for existing users.
- Existing `sync_season_workspace_v2` Save path fails for normal pending changes.
- `get_season_change_event_page` cannot be reached for known seasons.
- Edge Functions cannot access required runtime secrets on the self-hosted runtime.
- Desktop clients show repeated `Failed to fetch` against the self-hosted endpoint after local network issues are ruled out.

## Rollback Procedure

1. Stop publishing new self-hosted releases.
2. Restore GitHub repository variables:
   - `NEXT_PUBLIC_REMOTE_BACKEND=supabase`
   - `NEXT_PUBLIC_SUPABASE_URL=<rollback Supabase URL>`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<rollback anon key provided out-of-band>`
3. Trigger a signed rollback release.
4. Install the rollback build on a test workstation.
5. Verify login/session refresh, season list, `Fetch Server Updates`, Save, Dashboard, and Edge Functions against the rollback endpoint.
6. Keep the self-hosted database available for investigation until any cutover-window writes are reviewed.
7. Compare `season_change_events` high-water by season between rollback and self-hosted backends if any writes occurred during the cutover window.
8. Decide separately whether to replay, discard, or manually merge cutover-window writes.

## Deferred Backend Work

Server-side write hardening is not part of this cutover. Track it in `docs/handoffs/selfhosted-server-side-write-hardening.md` after the endpoint cutover is stable.
