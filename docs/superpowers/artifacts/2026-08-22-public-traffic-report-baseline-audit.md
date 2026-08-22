# Public traffic report baseline audit - 2026-08-22

## Status

Local implementation and verification are complete enough for a staging deployment package. Staging/production mutation has not been performed: the local workstation has no Nginx, cloudflared or Supabase CLI, the known server SSH endpoint rejected the available identity, and `reports.ahtops.xyz` does not yet exist in DNS. Production remains gated by staging evidence and explicit user acceptance.

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

Local PGlite validates query semantics and idempotent schema application; it is not evidence for production PostgreSQL latency, MVCC concurrency under a real writer, Nginx cache behavior or Tunnel latency.

## Infrastructure inventory result

- `https://supabase.ahtops.xyz` resolves and responds; unauthenticated `/auth/v1/health` returned HTTP 401, which proves reachability but not authenticated health.
- `reports.ahtops.xyz` returned NXDOMAIN on 2026-08-22 and is available to provision subject to DNS ownership.
- Known SSH inventory endpoint `ops@100.91.158.79` rejected the available authentication identity.
- Local executables: Nginx absent, cloudflared absent, Supabase CLI absent.

Required next authority: a staging server session/SSH identity (or operator execution of the runbook) plus DNS/named-tunnel access. After staging evidence is collected, explicit user acceptance is required before production publication.
