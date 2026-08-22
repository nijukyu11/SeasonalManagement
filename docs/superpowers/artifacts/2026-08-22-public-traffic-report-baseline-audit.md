# Public traffic report baseline audit - 2026-08-22

## Status

Local implementation and staging deployment are complete. The temporary acceptance URL is `https://exp-tell-nearly-imposed.trycloudflare.com/reports/traffic`. It is served by an isolated Cloudflare Quick Tunnel and has no uptime guarantee. Production hostname publication remains gated by explicit user acceptance and named-tunnel/DNS configuration.

## Effective leg identity and authoritative recency

The canonical V2 import function generates record IDs with `season_id`, so `record_id` cannot deduplicate a business occurrence across seasons. The import expansion contract separately uses an occurrence identity based on:

```text
(type, scheduled_date, normalized airline, normalized flight_number)
```

The public report uses that tuple as `business_leg_key`. Candidate recency is the latest server-owned `season_change_events.server_seq` for the record target, falling back to the server sequence of the season import event. It never uses a client clock, upload filename or season label.

All candidates, including deleted modifications/tombstones, are ranked before the final deleted filter. A newer deleted candidate therefore prevents an older cross-season candidate from reappearing. When a duplicate cohort has missing recency, or multiple candidates share the maximum authoritative recency, the complete cohort is quarantined.

PGlite contract tests cover a newer tombstone, missing-recency quarantine and the typed 04:59/05:00 Ops Date boundary.

## Pax source audit

The operational schema contains `pax integer` but no independent “reported” boolean/status and no canonical cargo/ferry exemption flag. The existing dashboard view inferred reported only from `pax > 0`; it used separate labels for zero/missing values but could not prove a reported zero.

The sample workbooks reinforce this limitation. Their source-style sheets contain many zero Pax values associated with blank, numeric-zero and operational Note values, but no stable field that proves “reported zero”. The public contract therefore:

- includes only `pax > 0` in reported Pax;
- keeps `0/null` as unknown rather than reported;
- calculates coverage over all effective legs at `scheduled_local_at + 1 day <= data_as_of` in `Asia/Ho_Chi_Minh`;
- keeps cargo/ferry in the denominator until an approved canonical exemption field exists.

PGlite tests cover before/exactly/after the T+1 boundary and verify that only positive reported Pax enters the total.

## Workbook reconciliation audit

Read-only sources:

- `docs/report_ref/SanLuong_Country_2026.xlsx`;
- `docs/report_ref/SanLuong_Week_S26.xlsx`;
- `docs/report_ref/SanLuongAPR.xlsx`.

The workbooks confirm the desired reporting dimensions: ARR/DEP, Ops Date, Airline, Route, Country, aircraft/config, Pax, weekly/monthly trends and peak-hour views. They are not canonical data sources.

One material Country exception appears consistently in the workbook audit: route `RMQ` is labeled both `China` and `Taiwan`. No workbook override is applied. Runtime Country uses `operational_route_countries`; a missing database mapping becomes `Unknown` and remains visible in quality metadata subject to the threshold of 3.

## Public privacy boundary

The public payload allowlist contains only aggregate Ops Date, ARR/DEP counts, reported Pax, coverage, Airline/Route/Country/aircraft-group breakdowns and hourly buckets. It excludes flight number, record/leg ID, exact schedule, gate, stand, carousel, operator and source provenance.

Cells with 1-2 legs are suppressed or folded into `Khác`. When exactly one small cell would be recoverable by subtraction, one additional publishable cell is complementary-suppressed. The same contract is used for JSON, timeline, breakdown, peak-hour and aggregate CSV.

## Local verification evidence

- `npm run test:traffic-report-contract`: pass;
- `npm run test:dashboard-contract`: pass;
- `npm run test:seasonal-schema-twice`: pass;
- `npm run test:rules`: pass;
- `npx tsc --noEmit --pretty false`: pass;
- `npm run build`: pass; static route `/reports/traffic` generated;
- public source and built-chunk import graph: pass, no desktop/Tauri/auth sentinel;
- local mocked browser smoke: one initial GET `/api/report/v1/overview`, no second metadata/overview request after URL normalization;
- visual review: 1440 px desktop and 500 px narrow viewport pass for hero, summary, filter and KPI hierarchy; exact 390 px automation is limited by the installed headless browser minimum viewport, so a real-device 360/390 smoke remains a staging gate;
- migration content at the end of `app/supabase/schema.sql` is byte-equivalent after newline normalization to `20260822090000_public_traffic_report_v1.sql`.

Local PGlite validates query semantics and idempotent schema application. Real PostgreSQL, Nginx and Tunnel evidence is recorded below.

## Initial infrastructure inventory result

- `https://supabase.ahtops.xyz` resolves and responds; unauthenticated `/auth/v1/health` returned HTTP 401, which proves reachability but not authenticated health.
- `reports.ahtops.xyz` returned NXDOMAIN on 2026-08-22 and is available to provision subject to DNS ownership.
- Known SSH inventory endpoint is `ops@100.91.158.79`; password authentication was subsequently authorized and succeeded through Paramiko.
- Local executables: Nginx absent, cloudflared absent, Supabase CLI absent.

## Staging deployment evidence

- Server: Debian 13, operator `ops`; existing remotely managed named Cloudflare Tunnel remained unchanged.
- Staging URL: `https://exp-tell-nearly-imposed.trycloudflare.com/reports/traffic` through a separate Quick Tunnel service.
- Current immutable static release: `/srv/seasonal-traffic-report/releases/20260822T114200Z-3acd8ae`.
- Static artifact SHA-256: `33dcb4852d6cd578973b63fa449be2a2c1f5d52cf70562150e1517d42abd977d` (179 files).
- Migration SHA-256: `a471a0deaee1f39354590e24b9caca282103f3fdd867e658e8b204e9da4b5cce`.
- Edge source SHA-256: `89899d63748a30081869604caea10c49a09035e79afefa6cc50596b77201d873`.
- Nginx config SHA-256: `9c10f16269dc33e233ea65c0ea0a519d06c07172e4729f496d35a6dbcfd46810`; `nginx -t` passed.
- The public Edge Runtime is isolated at `127.0.0.1:9001`; shared authenticated Edge Functions retain `VERIFY_JWT=true`.
- The browser sends no cookie, Authorization or API key. `anon` and `authenticated` cannot execute the wrapper; `service_role` can execute only the public aggregate wrapper and cannot execute the three internal reporting RPCs directly.
- Nginx is bound to `127.0.0.1:8780`; first overview request was `MISS`, subsequent request was `HIT`; Cloudflare reported `DYNAMIC`, confirming no Cloudflare cache in front of the API.
- Canonical request returns `308` with public relative `Location`; aggregate CSV returns `Cache-Control: no-store`; `season` is rejected with `400`; rate-limit testing produced `429` after the configured burst.
- Snapshot refresh timer, Nginx, isolated Edge and staging tunnel services are active. Snapshot watermark `45277` matched the source watermark; 60,379 effective rows were materialized.

## Staging data and performance checks

- Default range: `2026-01-01..2026-08-21`; `21,367` flights; `ARR + DEP = 21,367`.
- API totals matched the effective aggregate snapshot, timeline spine was `233/233`, and payload contained neither `flight_number` nor `record_id`.
- Full available domain contained 520 calendar days, including 85 explicit zero-flight days. One primary small cell and one complementary cell were explicitly suppressed.
- Direct isolated Edge/PostgREST/DB, concurrency 1, 50 requests: total p50 `153.3 ms`, p95 `183.5 ms`, p99 `297.0 ms`; origin p50 `151 ms`, p95 `179 ms`, p99 `184 ms`.
- Warm Nginx cache, concurrency 10, 20 successful requests: p50 `2.0 ms`, p95 `3.0 ms`, p99 `3.5 ms`.
- The warm database p95 target `<150 ms` is not yet met; the cache-hit target is met. This remains a visible acceptance/performance item rather than being hidden by cache.

## Staging variance requiring acceptance

To meet practical query latency without copying data into a second database, staging uses an indexed materialized aggregate refreshed every 20 seconds. Combined with the 60-second Nginx cache, the designed maximum observable age is under 90 seconds. This replaces the earlier plan wording “aggregate live per request, no periodic snapshot” and requires explicit acceptance before production publication.

Remaining gates: user acceptance of the staging behavior/visuals, exact 360/390 real-device accessibility smoke, resolution of the `<150 ms` warm database p95 target or acceptance of the measured result, and production named-tunnel/DNS configuration.
