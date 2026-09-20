# Production Release Receipt: Flight Category Binary Breakdown, Service Role ACL Hardening, and Staging Parity

- **Date:** 2026-09-20T04:55:00Z
- **Host:** `100.91.158.79`
- **Operator:** `ops` via Paramiko SSH
- **Production URL:** `https://report.ahtops.xyz/reports/traffic`
- **Production Release Directory:** `/srv/seasonal-traffic-report/releases/20260920T184000Z-flight-category-binary-clean`
- **Edge Functions Directory:** `/srv/seasonal-traffic-report/functions/20260920T214500Z-scoped-read-version-onhost`
- **Production Symlink:** `/srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260920T184000Z-flight-category-binary-clean`
- **Staging Symlink:** `/srv/seasonal-traffic-report/staging-current -> /srv/seasonal-traffic-report/releases/20260920T184000Z-flight-category-binary-clean`

---

## 1. Scope of Changes

1. **Binary Flight Category Card (`FlightCategoryChart`):**
   - Binary breakdown: `Thường lệ` (code J) vs `Không thường lệ` (code C and others).
   - Proportional stacked bar with metrics for flights, share, arrivals, departures, and reported passengers.
2. **Standardized Fleet Mix Wording (`FleetMixChart`):**
   - Updated labels: `Small - code C` (narrow-body) and `Big - code D, E` (wide-body).
3. **Database Migration & Strict ACL Invariant:**
   - Active on production database (`postgres`) and staging rehearsal (`report_rehearsal`):
     - `20260920183000_public_traffic_report_flight_category_binary.sql`: Binary classification in RPC.
     - `20260920200000_public_traffic_report_v2_strict_service_role_acl.sql`: Revokes ALL execution permissions on `public.get_public_traffic_report_v2` from `PUBLIC`, `anon`, `authenticated`, and grants strictly to `service_role`.
   - Verified privilege check on both databases: `anon_exec = false`, `auth_exec = false`, `service_exec = true` (`f|f|t`).
   - Direct unauthenticated PostgREST RPC call rejected with HTTP 401 Unauthorized:
     `{"code":"42501","details":null,"hint":null,"message":"permission denied for function get_public_traffic_report_v2"}`.
4. **Staging Edge Environment Parity:**
   - Reconstructed `/etc/seasonal-traffic-report/edge-staging.env` atomically with mode 600.
   - Added stable `TRAFFIC_REPORT_READ_VERSION_SECRET` (64-char hex) and export configuration flags.
   - Recreated `opsdata-traffic-report-edge-staging` with `--env-file /etc/seasonal-traffic-report/edge-staging.env` and verified all application environment keys present.

---

## 2. Verification Evidence

1. **Live Production Browser Rendering (Playwright 1440x900):**
   - URL: `https://report.ahtops.xyz/reports/traffic`
   - Page Title: `Báo cáo sản lượng khai thác`
   - `Thường lệ`: 4 occurrences observed.
   - `Không thường lệ`: 3 occurrences observed.
   - `Small - code C`: 2 occurrences observed.
   - `Big - code D, E`: 2 occurrences observed.
   - Viewport check: `scrollWidth = 1440`, `clientWidth = 1440`, `hasOverflow = False`.

2. **Independent HMAC-SHA256 Signature Verification:**
   - Evaluated using Python `hmac.new` with secret from `/etc/seasonal-traffic-report/edge.env`.
   - Token envelope: `rv1.…` (token length 296 characters; version=1, decoded claims verified).
   - Signature verification: independent HMAC-SHA256 computation matched the token signature byte-for-byte.

3. **Production Token-Bound Endpoint Checks (Port 8780 with `Host: report.ahtops.xyz`):**
   - `/api/report/v2/timeline`: HTTP 200 OK, returns 30 daily timeline items.
   - `/api/report/v2/dimension?dimension=airline`: HTTP 200 OK, returns 39 airline rows.
   - `/api/report/v2/dimension-share?dimension=airline`: HTTP 200 OK, returns `top_rows` with 10 items (e.g. `VJ` value=466, share=0.1413).

4. **In-View Filter Transition Check:**
   - Changed date range from `2026-06-01..2026-06-30` to `2026-06-05..2026-06-25` while preserving `read_version` token.
   - Result: HTTP 200 OK, returned 21 daily points without `READ_VERSION_INVALID` error.
