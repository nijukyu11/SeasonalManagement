# Public traffic report deploy and rollback

## Boundary

The public site is `https://report.ahtops.xyz/reports/traffic`. It is an anonymous, aggregate-only surface. The existing `https://supabase.ahtops.xyz` ingress remains the Supabase API authority and is not replaced.

Production publication is gated by user acceptance of staging. Do not point the production hostname at a new artifact before that acceptance is recorded.

## Prerequisites and inventory

Record, without printing credentials:

- server OS and operator;
- current Nginx binary/config root;
- existing named Cloudflare Tunnel service and config path;
- DNS ownership for `report.ahtops.xyz`;
- release root `/srv/seasonal-traffic-report/releases` and rollback symlink `/srv/seasonal-traffic-report/current`;
- database migration version, Edge Function version and static artifact SHA-256.

The repository workstation does not currently contain `nginx`, `cloudflared` or the Supabase CLI. Server inventory and deployment therefore require the infrastructure operator/session and must not be inferred from local files.

## Staging sequence

1. Build and test the commit: `npm ci`, `npm run test:traffic-report-contract`, `npm run test:rules`, `npx tsc --noEmit --pretty false`, then `npm run build:traffic-report`. The report build must fail closed if a desktop route or desktop marker appears in `app/out-report`.
2. Confirm `20260822090000_public_traffic_report_v1.sql` is already present and unchanged. After the main canonical cutover, apply the report migrations in timestamp order through `20260829210000_public_traffic_report_pax_presence_contract.sql`. Then apply the main-repository migration `20260830193000_public_traffic_aircraft_type_snapshot.sql` before the report-repository migration `20260830200000_public_traffic_report_aircraft_type_contract.sql`. Do not reverse these last two: the report contract fails closed unless the physical snapshot column exists. Run the report migration with `psql -1 -v ON_ERROR_STOP=1 -f ...` because the file intentionally relies on the caller-owned transaction. Validate the snapshot before applying that report transaction. Install the refresh runner, service and manual helper only after both migrations pass, but keep `seasonal-traffic-report-refresh.timer` disabled and inactive. Verify `anon` and `authenticated` cannot execute the reporting RPCs or select the reporting relations; verify the Edge service role can execute only the public wrappers used by the gateway.
3. Deploy the isolated `traffic-report-edge` container from `deploy/traffic-report/docker-compose.yml`. Generate `/etc/seasonal-traffic-report/edge.env` from the existing Edge container without printing credentials and keep it root-only (`0600`). The container binds only `127.0.0.1:9001` and disables JWT verification only for this public aggregate gateway. Confirm a browser request does not send or require Cookie, Authorization or apikey.
4. Copy only the immutable `app/out-report` artifact into a new timestamped staging release directory. Do not deploy `app/out`, because that full desktop export contains the Seasonal Management routes. Record the report-only artifact hash; do not overwrite the previous release. Point only `/srv/seasonal-traffic-report/staging-current` at this release; leave `/srv/seasonal-traffic-report/current` unchanged.
5. Keep the production Nginx server on `127.0.0.1:8780`. Install the separate server block from `deploy/traffic-report/nginx-staging.conf`, which listens on `127.0.0.1:8781` and reads only `staging-current`. Do not duplicate the http-level `proxy_cache_path` or `limit_req_zone` declarations. Run `nginx -t`, reload, and prove that `8780` still serves the prior production artifact while `8781` serves the new staging artifact.
6. For staging, run the isolated `seasonal-traffic-report-staging-tunnel` Quick Tunnel service against `127.0.0.1:8781` and record its temporary `trycloudflare.com` URL. The named tunnel and DNS for `report.ahtops.xyz` already remain active and must not change during staging. After acceptance, stop/remove the Quick Tunnel and switch only the production `current` symlink to the accepted immutable release; retain the existing named-tunnel routing and Cloudflare cache-bypass rule for `/api/report/*`.
7. After a successful manual refresh and cache-expiry allowance, smoke `healthz`, report HTML, overview JSON, canonical 308, export `no-store`, cache MISS/HIT/Age and a 429 rate-limit response. Confirm the API watermark matches the manual-refresh evidence; staging manual mode does not provide continuous freshness between acceptance sessions.
8. Run data reconciliation, accessibility, desktop-route/Tauri smoke and latency measurements. Ask the user to accept the staging URL.

## Annual passenger KPI dashboard

Apply `app/supabase/migrations/20260831150000_public_annual_passenger_kpi.sql` after the public traffic migrations, followed by `app/supabase/migrations/20260831190000_annual_passenger_kpi_owner.sql`. The first migration creates the protected annual configuration table, seeds KPI 2026 at `7,500,000` only when that year is not already configured, and grants only `service_role` access through aggregate RPC wrappers. The owner migration aligns the protected table with its `postgres`-owned SECURITY DEFINER writer while preserving the direct-access revocations. Reload the PostgREST schema cache after applying both migrations.

The dashboard is served at `/dashboard`. Add these values to the root-only Edge environment file; do not put them in a `NEXT_PUBLIC_*` variable or in the static artifact:

- `ANNUAL_KPI_ADMIN_PIN_HASH`: PBKDF2-SHA256 encoded hash generated by `npm run generate:kpi-pin-hash` with `ANNUAL_KPI_PIN` supplied only to that process. In the Docker Compose `env_file`, escape every literal `$` in the encoded hash as `$$`, then verify the recreated container receives the normal single-dollar PBKDF2 format.
- `ANNUAL_KPI_ADMIN_SESSION_SECRET`: at least 32 random characters, provisioned through the server secret workflow.
- `ANNUAL_KPI_ADMIN_ALLOWED_ORIGINS`: comma-separated exact origins, including `https://report.ahtops.xyz` and the active staging origin when admin testing is required.

The admin cookie is HttpOnly, Secure, SameSite=Strict and expires after 10 minutes. Confirm Nginx forwards cookies only for `/api/report/v1/kpi-admin/`, never caches that prefix, and still strips cookies from the remaining public report API.

For production, install `seasonal-traffic-report-refresh-production.timer` as `/etc/systemd/system/seasonal-traffic-report-refresh.timer` and enable it only after staging acceptance. Its five-minute calendar schedule cannot fall into an elapsed state after being enabled. The refresh runner first compares the committed source watermark with the published projection watermark. It exits with `unchanged` without refreshing the materialized view when they match; a full refresh runs only after a committed import/change advances the watermark or when the projection is stale/failed. A failed import transaction does not advance the watermark and therefore cannot publish a new dashboard version. Keep the staging timer disabled and use the manual helper during acceptance.

## Aircraft-type materialized-view cutover

Rehearse this sequence first on a PostgreSQL 17 production clone. The main migration builds two populated MVs while the existing report remains readable: one 17-column aircraft snapshot and one independently refreshable 16-column rollback snapshot. At the measured production baseline of about 2 minutes 20 seconds per refresh, budget roughly 5 minutes plus index time for this migration. The 60,312-row live MV was about 44 MB and the host had 347 GB free when audited; record fresh measurements before execution.

Before the migration, stop concurrent refresh work, capture a schema backup and fail closed if a new dependency appeared:

```bash
systemctl is-enabled seasonal-traffic-report-refresh.timer
systemctl is-active seasonal-traffic-report-refresh.timer
systemctl is-active seasonal-traffic-report-refresh.service

docker exec opsdata-supabase-db pg_dump \
  -U supabase_admin -d postgres --schema-only --schema=reporting --schema=public \
  | gzip > pre-aircraft-type-report-schema.sql.gz
sha256sum pre-aircraft-type-report-schema.sql.gz
```

```sql
select pg_describe_object(classid, objid, objsubid) as dependent, deptype
from pg_depend
where refobjid = 'reporting.public_traffic_effective'::regclass
  and deptype <> 'i';
```

Only the MV's own rule, indexes, row type and TOAST objects were present in the audited production snapshot. Stop if the live result contains a view, parsed SQL body or other external dependency. The migration uses `DROP MATERIALIZED VIEW` without `CASCADE`; an unexpected dependency or a lock wait longer than 5 seconds rolls back the complete transaction, including both newly built MVs.

Apply in this exact order, using a separate transaction for each migration:

1. `psql -v ON_ERROR_STOP=1 -f SeasonalManagement/app/supabase/migrations/20260830193000_public_traffic_aircraft_type_snapshot.sql` (the file owns its transaction).
2. Validate the canonical and rollback snapshots, OID change, indexes, row totals and projection state.
3. `psql -1 -v ON_ERROR_STOP=1 -f SeasonalManagement-web-traffic-report/app/supabase/migrations/20260830200000_public_traffic_report_aircraft_type_contract.sql` (the caller owns this atomic transaction).
4. Reload the PostgREST schema cache, then deploy the updated refresh helper, Edge function and static staging release only after both database steps pass.

The main migration drops the old canonical OID and renames the indexed stage in one transaction, forcing prepared plans to re-resolve the canonical relation name. Its lock window is metadata-only and capped at 5 seconds. It retains `reporting.public_traffic_effective_pre_aircraft_type` with the prior definition and populated data. It records the new snapshot as `fresh` immediately only when the captured snapshot watermark still equals the source watermark; if writes advanced during the build it records `stale` and requires the controlled refresh below. A successful equal-watermark cutover does not require a duplicate 140-second refresh merely to become available.

Record these postconditions before publication:

```sql
select status, source_watermark, refreshed_at, snapshot_rows, error
from reporting.public_traffic_projection_state
where projection_name = 'public_traffic_effective';

select count(*) as rows,
  count(*) filter (where aircraft_type is null or btrim(aircraft_type) = '') as invalid_aircraft_types,
  max(snapshot_source_watermark) as snapshot_watermark
from reporting.public_traffic_effective;

select count(*) as rollback_rows
from reporting.public_traffic_effective_pre_aircraft_type;
```

Also reconcile total flights, arrivals + departures, Pax-known legs, reported Pax, min/max Ops Date and aircraft child totals against their parent groups. Confirm `anon`, `authenticated` and `service_role` have no direct `SELECT` on either MV, the canonical business-key index is unique, and the internal timeline/dimension base functions are not executable by the Edge role.

The Phase 1 threshold/complementary-suppression policy is not formal differential privacy. The regression gate covers direct responses, representative `A`/`D`/`all` differencing, and stable decisions across pagination/export, but arbitrary sequences of overlapping route/airline/country filters can still create inference risk. Keep rate limits and aggregate-only access in place, record this accepted residual risk, and do not describe the public endpoint as immune to every differencing attack.

## Manual staging refresh before acceptance

Install the helper as root-owned executable and explicitly disable the timer:

```bash
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-report-refresh \
  /usr/local/sbin/seasonal-traffic-report-refresh
sudo install -o root -g root -m 0644 \
  deploy/traffic-report/seasonal-traffic-report-refresh.service \
  /etc/systemd/system/seasonal-traffic-report-refresh.service
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-report-refresh-manual \
  /usr/local/sbin/seasonal-traffic-report-refresh-manual
sudo systemctl disable --now seasonal-traffic-report-refresh.timer
sudo systemctl daemon-reload
```

Run this before each staging acceptance session and allow the command to finish, then allow another 60 seconds for any existing API cache entry to expire:

```bash
sudo /usr/local/sbin/seasonal-traffic-report-refresh-manual
```

The refresh service allows up to 300 seconds because the production materialized view has taken about 2 minutes 20 seconds. It records `fresh`/`empty` after a completed refresh and records `failed` if the refresh job fails. The manual command fails closed when the timer is still enabled/active, the refresh service fails, the snapshot is empty, the physical aircraft column contains NULL/blank values, or the source watermark changes during refresh. A successful result starts with `ready` and reports `refreshed_at_utc`, snapshot/source watermarks, row count and invalid-aircraft count. If it reports `source_changed_after_refresh`, wait until writes finish and run it again. The final 60-second allowance lets any pre-existing Nginx API cache entry expire without deleting unrelated cache files.

Confirm manual-refresh mode after every unit deployment or server reboot:

```bash
systemctl is-enabled seasonal-traffic-report-refresh.timer  # expected: disabled
systemctl is-active seasonal-traffic-report-refresh.timer   # expected: inactive
```

## Required evidence

- commit, release directory and artifact SHA-256;
- migration and Edge Function versions;
- disabled/inactive staging timer plus snapshot build/refresh time, matching snapshot/source watermarks, row count and zero invalid aircraft types;
- Nginx config fingerprint and successful config test;
- named tunnel ID/config fingerprint and DNS route;
- HTTP headers showing Cloudflare bypass and Nginx MISS then HIT;
- p50/p95/p99 for warm DB concurrency 1 and Nginx cache-hit concurrency 10, plus uncached Edge/Tunnel observations;
- min/max, full-range totals, ARR + DEP reconciliation, continuous date-spine count, Pax NULL versus true zero, and cross-request complementary-suppression cases;
- screenshots at 360, 768, 1280 and 1440 px plus keyboard/screen-reader/contrast checks;
- explicit user staging acceptance before production DNS/publication.

## Report live + Dashboard Daily Publication (feature-gated)

The additive A+B path remains disabled unless its build/runtime flags are explicitly set:

- `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED=1` switches the public Report to the live aggregate adapter.
- `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION=true` switches the 24/7 wallboard to the latest ready immutable publication.
- `TRAFFIC_REPORT_READ_VERSION_SECRET` is required by the Edge runtime to mint and verify Report Read Version tokens. Keep it out of artifacts and logs.

Do not enable either UI flag before the matching migration, Edge function, clone differential and staging smoke are accepted. The existing materialized-view path and refresh timer remain the rollback implementation during soak.

Install the Dashboard publisher only on an approved clone/staging host first:

```bash
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-dashboard-publish \
  /usr/local/sbin/seasonal-traffic-dashboard-publish
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-dashboard-accept \
  /usr/local/sbin/seasonal-traffic-dashboard-accept
```

After daily import/reconciliation has been accepted, capture the committed `season_change_events.server_seq` watermark and invoke the publisher with an explicit completed Business Date and that exact watermark:

```bash
sudo /usr/local/sbin/seasonal-traffic-dashboard-publish \
  2026-09-01 <EXPECTED_WATERMARK> daily_acceptance "Daily data accepted"
```

For a canonical Daily import, accept each current `dailyImport` receipt before publishing. The acceptance command verifies that every affected Ops Date still belongs to the same committed replacement batch/data version; a superseded event is rejected:

```bash
sudo /usr/local/sbin/seasonal-traffic-dashboard-accept \
  EVENT_SERVER_SEQ EXPECTED_WATERMARK daily-acceptance-runner \
  "Canonical Daily import committed and reconciled"
```

Future canonical Daily commits are captured automatically by the database trigger. The command remains the idempotent recovery/backfill Interface for already committed events.

Install hybrid orchestration after its migration and clone rehearsal are accepted:

```bash
sudo install -o root -g root -m 0755 \
  deploy/traffic-report/seasonal-traffic-dashboard-runner \
  /usr/local/sbin/seasonal-traffic-dashboard-runner
sudo install -o root -g root -m 0644 \
  deploy/traffic-report/seasonal-traffic-dashboard-runner.service \
  /etc/systemd/system/seasonal-traffic-dashboard-runner.service
sudo install -o root -g root -m 0644 \
  deploy/traffic-report/seasonal-traffic-dashboard-runner.timer \
  /etc/systemd/system/seasonal-traffic-dashboard-runner.timer
sudo install -o root -g root -m 0644 \
  deploy/traffic-report/seasonal-traffic-dashboard-wake-listener.service \
  /etc/systemd/system/seasonal-traffic-dashboard-wake-listener.service
sudo systemctl daemon-reload
sudo systemctl enable --now seasonal-traffic-dashboard-wake-listener.service
sudo systemctl enable --now seasonal-traffic-dashboard-runner.timer
sudo systemctl start seasonal-traffic-dashboard-runner.service
```

The database trigger emits `public_dashboard_daily_wake` through transactional `NOTIFY`; PostgreSQL delivers it only after the Daily Import transaction commits. The Listener Adapter starts the oneshot immediately and schedules retries after five and fifteen minutes. The persistent 15-minute timer then remains the missed-event/restart recovery path. Publisher work never runs inside the import transaction.

The runner owns the orchestration Interface:

- single-flight `flock`;
- 05:00–04:59 completed Ops Date selection;
- continuous canonical `complete` coverage;
- `fresh` projection with matching watermark and data version;
- maturity/Pax/A+D validation before creating an attempt;
- stable key `annual-kpi:year:BusinessDate:watermark`;
- immutable Publisher invocation;
- database head/checksum/freshness/missing-Pax verification;
- public current/version cache polling for the 60-second SLA.

Warnings and failures go to stdout, journald and syslog. If an executable `/usr/local/sbin/seasonal-traffic-dashboard-alert` exists, it is called as `LEVEL CODE MESSAGE`; this is the alert Adapter seam and must not mutate publication state.

The helper fails closed if the watermark changed, the receipt is not `ready`, or the current pointer does not equal the returned publication id. `incomplete`, `empty`, `rejected_version` and `failed` attempts remain audit evidence and never replace last-known-good. A correction uses `manual_correction`, a reason and an explicit new idempotency key; it creates a new immutable row rather than editing the old one.

Smoke the two small read contracts without direct ledger access:

```text
GET /api/report/v1/dashboard-publication?year=2026
GET /api/report/v1/dashboard-publication-version?year=2026
```

Verify publication id, Business Date, checksum, metrics version, source watermark, `freshness`, ETag and cache headers. A missing ready publication is an explicit `DASHBOARD_PUBLICATION_NOT_READY`; a newer failed attempt keeps the ready payload but reports stale freshness.

## Rollback

1. Point `/srv/seasonal-traffic-report/current` back to the prior immutable release and reload Nginx.
2. Restore the prior Nginx include and named-tunnel ingress config if routing changed, validate both, then reload.
3. Redeploy the prior Edge Function version if the gateway caused the incident.
4. If the aircraft snapshot itself caused the incident, use the populated rollback MV transaction below. The current public wrapper detects the 16-column rollback and returns an empty `aircraft_type` array, so it does not execute a helper against a missing column. Do not modify raw seasonal data and do not use `CASCADE`.
5. Purge only the exact `traffic_report` Nginx cache zone/path owned by this deployment. Preserve unrelated caches and tunnel routes.

To roll back only the staging manual-refresh policy, restore the backed-up timer/service units, run `systemctl daemon-reload`, then enable and start the restored timer. Record the restored unit hashes and next trigger time.

To stop only hybrid publication orchestration while preserving the latest ready head and immutable ledger:

```bash
sudo systemctl disable --now seasonal-traffic-dashboard-runner.timer
sudo systemctl disable --now seasonal-traffic-dashboard-wake-listener.service
sudo systemctl stop seasonal-traffic-dashboard-runner.service
```

After rollback, verify the previous report or a controlled maintenance response, existing Supabase health, and unchanged desktop routes.

Database-only aircraft snapshot rollback:

```sql
begin;
set local lock_timeout = '5s';

drop materialized view reporting.public_traffic_effective;
alter materialized view reporting.public_traffic_effective_pre_aircraft_type
  rename to public_traffic_effective;

alter index reporting.public_traffic_effective_pre_ac_business_leg_idx
  rename to public_traffic_effective_business_leg_idx;
alter index reporting.public_traffic_effective_pre_ac_ops_date_idx
  rename to public_traffic_effective_ops_date_idx;
alter index reporting.public_traffic_effective_pre_ac_airline_ops_idx
  rename to public_traffic_effective_airline_ops_idx;
alter index reporting.public_traffic_effective_pre_ac_route_ops_idx
  rename to public_traffic_effective_route_ops_idx;
alter index reporting.public_traffic_effective_pre_ac_country_ops_idx
  rename to public_traffic_effective_country_ops_idx;
alter index reporting.public_traffic_effective_pre_ac_aircraft_group_ops_idx
  rename to public_traffic_effective_aircraft_group_ops_idx;

update reporting.public_traffic_projection_state
set status = 'stale', error = 'Aircraft-type snapshot rolled back; controlled refresh is required'
where projection_name = 'public_traffic_effective';
commit;
```

Then start `seasonal-traffic-report-refresh.service` once and verify that it completes, marks the rollback snapshot fresh and preserves the source watermark. The aircraft-aware manual helper deliberately requires the new column, so restore the backed-up previous helper or use the service plus explicit SQL postconditions while the 16-column rollback is active. Wait 60 seconds for cache expiry. Rehearse both forward cutover and this reverse transaction on the clone; record relation OIDs before/after to prove prepared-plan invalidation and keep the failed/new MV only in the schema backup, not via a full-database restore.
