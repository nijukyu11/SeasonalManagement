# Staging Release Receipt: Traffic Report Flight Category & Fleet Mix Standardization

- **Date:** 2026-09-20 (Server UTC: 2026-09-19T23:54:32Z)
- **Operator:** `ops` via Paramiko (host `100.91.158.79`)
- **Git Commit:** `dcdf03b` (on `main`)
- **Staging Release Directory:** `/srv/seasonal-traffic-report/releases/20260919T235432Z-flight-category-and-fleet-mix`
- **Production Current (Retained):** `/srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export`
- **Staging Quick Tunnel URL:** `https://sofa-warriors-cooler-package.trycloudflare.com/reports/traffic`
- **Production URL (Unchanged):** `https://report.ahtops.xyz/reports/traffic`

---

## 1. Verified Artifact Digests

- **Tarball:** `verified_v2_artifact.tar.gz`
  - SHA-256: `073e810d4862f66d223381f82bd83f716e2ba76fe8e6de203cceabb036a24fdf`
- **Prerendered HTML (`reports/traffic.html`):**
  - SHA-256: `c66183cd911e834b2d0b5a914d654e2ea614beb6e2c57c993c4581f1ed81e66f`

---

## 2. Server Inventory & Component Versions

- **Database:** Supabase PostgreSQL 17.6.1.136 (`opsdata-supabase-db`)
- **Edge Runtime:** `supabase/edge-runtime:v1.74.0` (`opsdata-traffic-report-edge` on port 9001, staging `opsdata-traffic-report-edge-staging` on port 9002)
- **Database Migration:** `20260920150000_public_traffic_report_flight_category.sql`
  - Action: Patches `public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)` to extract `flight_category` (J, C, OTHER) from canonical `public.season_flight_records` matching `(season_id, record_id)`, includes it in the dimensions lateral join, and generates the `flight_category` breakdown in the v2 response payload.
- **Nginx Configs (Byte-exact parity with tracked repository):**
  - Production (`/etc/nginx/conf.d/traffic-report.conf`): `a064ae9caf9087f2140683a7fdab3513c3b49e94e3dec6b9a3a945e2509805f7`
  - Staging (`/etc/nginx/conf.d/traffic-report-staging.conf`): `1d20cacbd1898f4aa9a6f4849906c2fc368b315d1de1e681e64dc2da775ca94e`
  - Test result: `nginx -t` passed syntax check and test successful.
- **Named Tunnel:** `cloudflared` systemd unit running with token `eyJhIjoiOTk4...` routing `report.ahtops.xyz` to port 8780.
- **Staging Quick Tunnel:** `seasonal-traffic-report-staging-tunnel.service` routing port 8781 to `https://sofa-warriors-cooler-package.trycloudflare.com`.

---

## 3. Manual Refresh Evidence (Staging Acceptance Session)

- `seasonal-traffic-report-refresh.timer` stopped and disabled (`inactive`, `disabled`).
- Manual refresh script executed: `/usr/local/sbin/seasonal-traffic-report-refresh-manual`
- Snapshot Receipt:
  ```
  status|refreshed_at_utc|snapshot_watermark|source_watermark|row_count|invalid_aircraft_type_rows
  ready|2026-09-19T06:50:00Z|55107|55107|66402|0
  ```
- 65-second Nginx API cache expiry allowance observed.

---

## 4. Smoke & Gate Test Results (Strict Assertions)

1. **Both-port healthz:**
   - `http://127.0.0.1:8780/healthz`: HTTP 200 OK (`ok`)
   - `http://127.0.0.1:8781/healthz`: HTTP 200 OK (`ok`)
2. **Canonical 308 redirect:**
   - `GET /` on 8781: `HTTP/1.1 308 Permanent Redirect`, `Location: /reports/traffic`
3. **Export `no-store` header:**
   - `GET /api/report/v1/export?from=2026-09-01&to=2026-09-05`: HTTP 200 OK, `Content-Type: text/csv`, `cache-control: no-store`
4. **Cache MISS -> HIT on overview URL:**
   - Request 1 on `/api/report/v2/overview`: HTTP 200 OK, `X-Cache-Status: MISS`
   - Request 2 on `/api/report/v2/overview`: HTTP 200 OK, `X-Cache-Status: HIT`
   - *Note on Age:* RFC 7234 `Age` header is not emitted by standard open-source Nginx proxy_cache; documented as platform/config limitation while MISS/HIT lifecycle is verified.
5. **Rate Limiting 429:**
   - Rapid burst on `/api/report/` triggered `HTTP 429 Too Many Requests`.
6. **Watermark Reconciliation:**
   - API `source_watermark`: `55107`
   - DB `reporting.public_traffic_projection_state`: `source_watermark = 55107`, `source_data_version = 16596`, `snapshot_rows = 66402`
   - Byte-exact match.
7. **Desktop/Tauri isolation:**
   - Zero desktop routes (`/turns`, `/seasons`, `/checkin`, `/gate`, `/flights`, `/admin`, `/import`) in `/srv/seasonal-traffic-report/staging-current/`.
8. **Latency & Performance Measurements:**
   - HTML fetch: `HTML: 0.000278s`, `TTFB: 0.000260s`
   - Uncached DB latency (10 runs): `p50=1.8ms`, `p95=141.6ms`, `p99=141.6ms`
   - Nginx Cache HIT latency (20 runs): `p50=0.2ms`, `p95=0.4ms`, `p99=0.4ms`

---

## 5. Data Reconciliation (Full Operational Range 2026-01-01 to 2026-09-19)

- **Date Spine:** 262 continuous operational days (`2026-01-01` to `2026-09-19`)
- **Total Flights:** 31,762
- **Arrivals:** 15,894 | **Departures:** 15,868 | **ARR + DEP = 31,762** (Exact match)
- **Reported Pax:** 5,507,527 | **True-zero Legs:** 40
- **Flight Category Breakdown:**
  - `Thường lệ (code J)`: 28,976 flights (91.2%), Arr: 14,495, Dep: 14,481, Pax: 4,938,372
  - `Không thường lệ (code C)`: 2,486 flights (7.8%), Arr: 1,248, Dep: 1,238, Pax: 509,369
  - `Khác`: 300 flights (0.9%), Arr: 151, Dep: 149, Pax: 59,786
  - *Sum check:* 28,976 + 2,486 + 300 = 31,762 (100.0% reconciled)
- **Aircraft Group (Fleet Mix) Breakdown:**
  - `Small - code C`: 28,065 flights (88.4%), Arr: 14,044, Dep: 14,021
  - `Big - code D, E`: 3,030 flights (9.5%), Arr: 1,516, Dep: 1,514
  - `Unknown`: 667 flights (2.1%), Arr: 334, Dep: 333
  - *Sum check:* 28,065 + 3,030 + 667 = 31,762 (100.0% reconciled)

---

## 6. Multi-Viewport & Accessibility Verification

- **360 × 640:** PASS (`tmp/staging-360px.png`, horizontal overflow: False)
- **768 × 1024:** PASS (`tmp/staging-768px.png`, horizontal overflow: False)
- **1280 × 800:** PASS (`tmp/staging-1280px.png`, horizontal overflow: False)
- **1440 × 900:** PASS (`tmp/staging-1440px.png`, horizontal overflow: False)
- **Keyboard Navigation:** Verified Tab sequence navigating interactive landmarks, filters, and charts.

---

## 7. Production Cutover Status

- **Staging Acceptance:** **PENDING USER ACCEPTANCE**
  - Staging URL: `https://sofa-warriors-cooler-package.trycloudflare.com/reports/traffic`
  - Production hostname `https://report.ahtops.xyz/reports/traffic` is preserved on `20260919T031500Z-ui-ux-with-html-export`.
  - Cutover will be executed only after explicit user acceptance of the staging URL.
