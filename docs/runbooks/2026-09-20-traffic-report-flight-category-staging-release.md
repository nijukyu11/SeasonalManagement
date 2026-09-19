# Staging Release Receipt: Traffic Report Flight Category & Fleet Mix Standardization

- **Date:** 2026-09-20 (Server UTC: 2026-09-19T23:54:32Z)
- **Operator:** `ops` via Paramiko (host `100.91.158.79`)
- **Staging Release Directory:** `/srv/seasonal-traffic-report/releases/20260919T235432Z-flight-category-and-fleet-mix`
- **Production Current (Retained):** `/srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export`
- **Staging Quick Tunnel:** `https://sofa-warriors-cooler-package.trycloudflare.com/reports/traffic`

## 1. Verified Artifact Digests

- **Verified Tarball:** `verified_v2_artifact.tar.gz`
  - SHA-256: `073e810d4862f66d223381f82bd83f716e2ba76fe8e6de203cceabb036a24fdf`
- **`reports/traffic.html`:**
  - SHA-256: `c66183cd911e834b2d0b5a914d654e2ea614beb6e2c57c993c4581f1ed81e66f`

## 2. Server State & Symlink Isolation

```bash
lrwxrwxrwx 1 root root 77 Sep 20 06:54 /srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export
lrwxrwxrwx 1 root root 84 Sep 20 06:54 /srv/seasonal-traffic-report/staging-current -> /srv/seasonal-traffic-report/releases/20260919T235432Z-flight-category-and-fleet-mix
```

## 3. Database Migration Applied

- Migration: `20260920150000_public_traffic_report_flight_category.sql`
- Applied via PGlite dry-run and Supabase Postgres authority.
- Added `reporting.public_traffic_effective_flight_category_v2` and updated `public.get_public_traffic_report_overview_v2`.

## 4. Playwright Staging Verification (1440 × 900)

- **Operations Section Title:** PASS (`Giờ và cơ cấu khai thác`)
- **Fleet Mix Component:** PASS (`Small - code C: 28.065 · 88,4%`, `Big - code D, E: 3.030 · 9,5%`)
- **Flight Category Component:** PASS (`Thường lệ (code J): 28.976 · 91,2%`, `Không thường lệ (code C): 2.486 · 7,8%`, `Khác: 300 · 0,9%`)
- **Day of Week Component:** PASS
- **Peak Hour 24h Table:** PASS
- **Horizontal Overflow:** False (no horizontal scrollbar at 1440px)

## 5. Next Steps for Production Cutover

Per runbook rules (`docs/runbooks/public-traffic-report-deploy.md`):
1. Review staging URL `https://sofa-warriors-cooler-package.trycloudflare.com/reports/traffic`.
2. Upon user acceptance, atomically switch `/srv/seasonal-traffic-report/current` to `/srv/seasonal-traffic-report/releases/20260919T235432Z-flight-category-and-fleet-mix`.
3. Stop `seasonal-traffic-report-staging-tunnel.service`.
