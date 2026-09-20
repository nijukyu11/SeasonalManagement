# Production Release Receipt: Binary Flight Category Classification

- **Date**: 2026-09-20T08:05:00Z
- **Author**: Ops / Codex Team
- **Target Host**: `100.91.158.79` (ops@100.91.158.79)
- **Production URL**: `https://report.ahtops.xyz`
- **Staging URL**: `https://sofa-warriors-cooler-package.trycloudflare.com`
- **Release ID**: `20260920T184000Z-flight-category-binary-clean`
- **Release Artifact SHA-256**: `d0ce21b05a4b2ae6214ea66c0700e098d9aeab8e21bdcf2e27490b8f60ac1682`

---

## 1. Objectives & Scope

1. **Binary Categorization**:
   - Classify all flights strictly into 2 groups:
     - `Thường lệ` (Code `J`)
     - `Không thường lệ` (Code `C` and all other non-J flight categories).
2. **Clean Labels**:
   - Omit internal/technical suffixes `(code J)` and `(code C)`.
   - Update subtitle to: *"Tỉ trọng số chuyến giữa chuyến bay thường lệ và không thường lệ (đã bao gồm các chuyến bay khác)."*
3. **Full Lineage & Zero-Downtime Deployment**:
   - Database migration applied to `opsdata-supabase-db` with PGlite verification, rollback rehearsal in probe transaction, and remote host audit receipt.
   - Dual-surface staging verification (`/reports/traffic` & `/reports/traffic/dashboard`) before atomic symlink switch on production.

---

## 2. Database Migration & Rollback Audit

- **Migration File**: `app/supabase/migrations/20260920183000_public_traffic_report_flight_category_binary.sql`
- **Rollback File**: `app/supabase/migrations/20260920183000_public_traffic_report_flight_category_binary.rollback.sql`
- **Remote Receipt**: `/home/ops/flight-category-binary-20260920/` (`sha256sum -c SHA256SUMS` verified OK on host).
- **Post-Migration Function MD5**: `425805e862bfd3e0551fa8d5c814ec4b`
- **Arithmetic Verification**:
  - `scheduled`: 28,976 flights (arr 14,495, dep 14,481, pax 4,938,372, share 91.2%)
  - `charter`: 2,786 flights (arr 1,399, dep 1,387, pax 569,155, share 8.8%)
  - Exact sum: $2,486 \text{ (code C)} + 300 \text{ (other)} = 2,786 \text{ flights}$.

---

## 3. Staging & Production Verification

- **HTTP Status**:
  - `https://report.ahtops.xyz/healthz`: `200`
  - `https://report.ahtops.xyz/reports/traffic`: `200`
  - `https://report.ahtops.xyz/reports/traffic/dashboard`: `200`
- **Playwright Verification**:
  - Desktop (1440 × 900): `hasHorizontalOverflow = false`, 2 items rendered cleanly.
  - Mobile (390 × 844): `hasHorizontalOverflow = false`, card width 308px, no truncation.
  - Annual KPI Dashboard: 0 error banners, Title & H1 confirmed.

---

## 4. Symlinks on Host

```bash
lrwxrwxrwx 1 root root 83 Sep 20 08:01 /srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260920T184000Z-flight-category-binary-clean
lrwxrwxrwx 1 root root 83 Sep 20 07:59 /srv/seasonal-traffic-report/staging-current -> /srv/seasonal-traffic-report/releases/20260920T184000Z-flight-category-binary-clean
```
