# Public traffic report deploy and rollback

## Boundary

The public site is `https://reports.ahtops.xyz/reports/traffic`. It is an anonymous, aggregate-only surface. The existing `https://supabase.ahtops.xyz` ingress remains the Supabase API authority and is not replaced.

Production publication is gated by user acceptance of staging. Do not point the production hostname at a new artifact before that acceptance is recorded.

## Prerequisites and inventory

Record, without printing credentials:

- server OS and operator;
- current Nginx binary/config root;
- existing named Cloudflare Tunnel service and config path;
- DNS ownership for `reports.ahtops.xyz`;
- release root `/srv/seasonal-traffic-report/releases` and rollback symlink `/srv/seasonal-traffic-report/current`;
- database migration version, Edge Function version and static artifact SHA-256.

The repository workstation does not currently contain `nginx`, `cloudflared` or the Supabase CLI. Server inventory and deployment therefore require the infrastructure operator/session and must not be inferred from local files.

## Staging sequence

1. Build and test the commit: `npm ci`, `npm run test:traffic-report-contract`, `npm run test:rules`, `npx tsc --noEmit --pretty false`, then `npm run build`.
2. Apply `20260822090000_public_traffic_report_v1.sql` to staging. Install `seasonal-traffic-report-refresh.service` and `seasonal-traffic-report-refresh-manual`, but keep `seasonal-traffic-report-refresh.timer` disabled and inactive. Refresh manually before each acceptance session. Verify `anon` and `authenticated` cannot execute the four RPCs or select the reporting relations; verify the Edge service role can execute only the public wrapper used by the gateway.
3. Deploy the isolated `traffic-report-edge` container from `deploy/traffic-report/docker-compose.yml`. Generate `/etc/seasonal-traffic-report/edge.env` from the existing Edge container without printing credentials and keep it root-only (`0600`). The container binds only `127.0.0.1:9001` and disables JWT verification only for this public aggregate gateway. Confirm a browser request does not send or require Cookie, Authorization or apikey.
4. Copy the immutable `app/out` artifact into a new timestamped staging release directory. Record its hash; do not overwrite the previous release.
5. Install the Nginx config from `deploy/traffic-report/nginx.conf`, run `nginx -t`, then reload. Nginx owns the shared cache for `/api/report`; no stale cache serving or background update is allowed.
6. For staging, run the isolated `seasonal-traffic-report-staging-tunnel` Quick Tunnel service and record its temporary `trycloudflare.com` URL. After acceptance, remove that staging service, merge the production hostname from `cloudflared-ingress.yml.example` into the existing remotely managed named tunnel, and configure Cloudflare Cache Rules to bypass `/api/report/*`.
7. After a successful manual refresh and cache-expiry allowance, smoke `healthz`, report HTML, overview JSON, canonical 308, export `no-store`, cache MISS/HIT/Age and a 429 rate-limit response. Confirm the API watermark matches the manual-refresh evidence; staging manual mode does not provide continuous freshness between acceptance sessions.
8. Run data reconciliation, accessibility, desktop-route/Tauri smoke and latency measurements. Ask the user to accept the staging URL.

## Manual staging refresh before acceptance

Install the helper as root-owned executable and explicitly disable the timer:

```bash
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-report-refresh-manual \
  /usr/local/sbin/seasonal-traffic-report-refresh-manual
sudo systemctl disable --now seasonal-traffic-report-refresh.timer
sudo systemctl daemon-reload
```

Run this at least 65 seconds before each staging acceptance session:

```bash
sudo /usr/local/sbin/seasonal-traffic-report-refresh-manual
```

The command fails closed when the timer is still enabled/active, the refresh service fails, the snapshot is empty, or the source watermark changes during refresh. A successful result starts with `ready` and reports `refreshed_at_utc`, snapshot/source watermarks and row count. If it reports `source_changed_after_refresh`, wait until writes finish and run it again. The final 60-second allowance lets any pre-existing Nginx API cache entry expire without deleting unrelated cache files.

Confirm manual-refresh mode after every unit deployment or server reboot:

```bash
systemctl is-enabled seasonal-traffic-report-refresh.timer  # expected: disabled
systemctl is-active seasonal-traffic-report-refresh.timer   # expected: inactive
```

## Required evidence

- commit, release directory and artifact SHA-256;
- migration and Edge Function versions;
- disabled/inactive staging timer plus successful manual refresh time, matching snapshot/source watermarks and row count;
- Nginx config fingerprint and successful config test;
- named tunnel ID/config fingerprint and DNS route;
- HTTP headers showing Cloudflare bypass and Nginx MISS then HIT;
- p50/p95/p99 for warm DB concurrency 1 and Nginx cache-hit concurrency 10, plus uncached Edge/Tunnel observations;
- min/max, full-range totals, ARR + DEP reconciliation, continuous date-spine count and suppression cases;
- screenshots at 360, 768, 1280 and 1440 px plus keyboard/screen-reader/contrast checks;
- explicit user staging acceptance before production DNS/publication.

## Rollback

1. Point `/srv/seasonal-traffic-report/current` back to the prior immutable release and reload Nginx.
2. Restore the prior Nginx include and named-tunnel ingress config if routing changed, validate both, then reload.
3. Redeploy the prior Edge Function version if the gateway caused the incident.
4. Database objects are additive. Revoke service-role execution on the wrapper first to fail closed. Drop the v1 functions/views only after confirming no active release references them; do not roll back by modifying raw seasonal data.
5. Purge only the exact `traffic_report` Nginx cache zone/path owned by this deployment. Preserve unrelated caches and tunnel routes.

To roll back only the staging manual-refresh policy, restore the backed-up timer/service units, run `systemctl daemon-reload`, then enable and start the restored timer. Record the restored unit hashes and next trigger time.

After rollback, verify the previous report or a controlled maintenance response, existing Supabase health, and unchanged desktop routes.
