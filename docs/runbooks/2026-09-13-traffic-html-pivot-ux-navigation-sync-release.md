# Biên bản phát hành Production: Đồng bộ điều hướng 2 chiều và Chuyển cảnh thông minh Báo cáo HTML Pivot

**Thời gian hoàn tất:** 19:15 ngày 13/09/2026 (Asia/Ho_Chi_Minh)  
**Phạm vi:** Phát hành chuyên biệt Edge Functions (Edge-functions-only). Tuyệt đối không sửa đổi static Next.js UI (`current` giữ nguyên bản hiện hành), database hay Nginx.

---

### 1. Thông tin phiên bản & Lineage máy chủ

- **Mã phát hành (Release ID):** `20260913T124500Z-html-pivot-ux-navigation-sync`
- **Đường dẫn functions trên máy chủ:** `/srv/seasonal-traffic-report/functions/20260913T124500Z-html-pivot-ux-navigation-sync`
- **Nhánh Git & Worktree nguồn:** `codex/web-traffic-report` tại `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report` (Head commit: `ec82ecd`).
- **Bản Static UI hiện hành (Không chạm vào):**
  `/srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260912T062757Z-compact-sticky-bar`
- **Thành phần bất biến khác:**
  - Database schema & Materialized Views: Giữ nguyên 100%.
  - Cấu hình Nginx `/etc/nginx/conf.d/traffic-report.conf`: Giữ nguyên 100%.
  - Cấu hình cờ môi trường `/etc/seasonal-traffic-report/edge.env`: Giữ nguyên 100%.

---

### 2. Bảng mã băm SHA-256 đối soát

Toàn bộ cây thư mục functions được clone từ release trước (`20260913T073000Z-comprehensive-html-pivot-ux`) và cập nhật đúng 6 file trong `_shared/`. Kết quả đối soát SHA-256 giữa máy cục bộ và máy chủ production khớp byte-for-byte 100%:

| Tệp tin | SHA-256 Checksum | Trạng thái máy chủ |
| :--- | :--- | :--- |
| `_shared/trafficHtmlMonthlyRuntime.ts` | `9677cb2177930c0aba094751c9d7d84f53095e55ef1f7ef30c395fb404944313` | Khớp 100% |
| `_shared/trafficHtmlMonthlyStyles.ts` | `0a7857a45b2c899b5ea743e934074fba19bcd6e87b8a6890b4cf054051256871` | Khớp 100% |
| `_shared/trafficHtmlPivotRuntime.ts` | `534b0aa0530e8b5e46e43d648dab1797764cf894b5eb05b1852b53df97de1cf8` | Khớp 100% |
| `_shared/trafficHtmlPivotStyles.ts` | `f8553b7c8a728fa1c3af155665d5b40ea4a78a2ea593ad29bd6e4f3fd24d20e3` | Khớp 100% |
| `_shared/trafficHtmlReportRenderer.ts` | `44aeab22c7df225ad32ffdb5b00053dda9ea0c2ecdc2bdd066a4cebe1df4dd37` | Khớp 100% |
| `_shared/trafficHtmlReportRuntime.ts` | `f5e9648dff739a7d03415e7ceee662563df4d7a152093d2f56396d8e0fe77d69` | Khớp 100% |

---

### 3. Quy trình nghiệm thu an toàn đã thực hiện

1. **Kiểm tra Canary độc lập (Port 9003)**:
   - Khởi chạy container canary tạm thời `opsdata-traffic-report-edge-canary` trên port `9003` với mount functions mới.
   - Kiểm tra endpoint `/traffic-report/v2/html-export` với cả 4 mẫu báo cáo:
     - `WEEKLY_DETAIL`: HTTP 200 (855,454 bytes).
     - `PERIOD_ANALYSIS`: HTTP 200 (614,036 bytes).
     - `BAO_CAO_SAN_LUONG`: HTTP 200 (6,418,926 bytes).
     - `MONTHLY_OVERVIEW_L2` (Tháng 10/2026): HTTP 200 (2,093,497 bytes).
2. **Kiểm tra tính bất biến của các endpoint phi HTML (Port 9001 vs Port 9003)**:
   - `/traffic-report/v1/dashboard-publication?year=2026`: Trùng khớp byte-for-byte (**2,564 bytes**, `cmp` IDENTICAL).
   - `/traffic-report/v1/annual-kpi?year=2026`: Trùng khớp byte-for-byte (**1,774 bytes**, `cmp` IDENTICAL).
   - Dọn dẹp container Canary an toàn.
3. **Thực thi Cutover & Khởi động lại dịch vụ Edge**:
   - Sao lưu cấu hình `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260913-navsync`.
   - Cập nhật mount trỏ về `/srv/seasonal-traffic-report/functions/20260913T124500Z-html-pivot-ux-navigation-sync`.
   - Tái tạo và khởi động lại container `opsdata-traffic-report-edge` bằng Docker Compose.
   - Kiểm tra trực tiếp port 9001: cả 4 endpoint phản hồi HTTP 200 OK.
4. **Smoke Test Ingress công khai (`https://report.ahtops.xyz`)**:
   - `https://report.ahtops.xyz/healthz`: **HTTP/2 200**.
   - `https://report.ahtops.xyz/reports/traffic`: **HTTP/2 200**.
   - `https://report.ahtops.xyz/reports/traffic/dashboard`: **HTTP/2 200**.
5. **Kiểm thử tự động trên trình duyệt thật (Playwright Test trên HTML tải trực tiếp từ Production)**:
   - Tải file HTML thực tế từ production live về máy (`prod-live-weekly.html`, 855,454 bytes).
   - Mở offline trên Microsoft Edge headless qua Playwright:
     - **0 lỗi JavaScript (`errors = []`)**.
     - Thanh View Mode Bar `[📊 Báo cáo chuẩn] [Bảng pivot mẫu]` hiển thị rõ nét trên header.
     - Chuyển sang Pivot mode: tự động đồng bộ góc nhìn `Thị trường` (`country`), hiển thị Pivot Clue Banner.
     - Nút `Tóm tắt và phân tích` có class `.tab-mode-switch` và vách ngăn `.tab-divider` phân tách rõ ràng.
     - Bấm quay về Tổng quan: bảo toàn chính xác tab `Thị trường` (`market`), hiển thị Summary Clue Banner.

---

### 4. Hướng dẫn Rollback nhanh (khi cần thiết)

Nếu cần quay lại phiên bản Edge Functions trước đó ngay lập tức:

```bash
sudo cp /srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260913-navsync /srv/seasonal-traffic-report/infra/docker-compose.yml
sudo docker compose -f /srv/seasonal-traffic-report/infra/docker-compose.yml up -d traffic-report-edge
```
