# Biên bản phát hành Production: Nâng cấp toàn diện UI/UX và hoàn thiện thông tin Báo cáo HTML Pivot

**Thời gian hoàn tất:** 14:15 ngày 13/09/2026 (Asia/Ho_Chi_Minh)  
**Phạm vi:** Phát hành chuyên biệt Edge Functions (Edge-functions-only). Không sửa đổi static Next.js UI (`current` giữ nguyên bản hiện hành), database hay Nginx.

---

### 1. Thông tin phiên bản & Lineage máy chủ

- **Mã phát hành (Release ID):** `20260913T073000Z-comprehensive-html-pivot-ux`
- **Đường dẫn functions trên máy chủ:** `/srv/seasonal-traffic-report/functions/20260913T073000Z-comprehensive-html-pivot-ux`
- **Bản Static UI hiện hành (Không chạm vào):**
  `/srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260912T062757Z-compact-sticky-bar`
- **Thành phần bất biến khác:**
  - Database schema & Materialized Views: Giữ nguyên 100%.
  - Cấu hình Nginx `/etc/nginx/conf.d/traffic-report.conf`: Giữ nguyên 100%.
  - Cấu hình cờ môi trường `/etc/seasonal-traffic-report/edge.env`: Giữ nguyên 100%.

---

### 2. Bảng mã băm SHA-256 đối soát

Các file cập nhật trên máy chủ production khớp byte-for-byte với mã nguồn cục bộ:

| Tệp tin | SHA-256 Checksum | Trạng thái máy chủ |
| :--- | :--- | :--- |
| `_shared/trafficHtmlPivotRuntime.ts` | `726a55c844ba9326bc9af730b44ebdf503de5f3f79d1f76ce74de9c2887bfe47` | Khớp 100% |
| `_shared/trafficHtmlPivotStyles.ts` | `6eea5e9a170b3bb46d6263548e6cc6a484190fc4700e11fa255d5f51ba1d44f4` | Khớp 100% |

---

### 3. Quy trình nghiệm thu an toàn đã thực hiện

1. **Kiểm tra Canary độc lập (Port 9003)**:
   - Khởi chạy container canary tạm thời trên port `9003` với mount functions mới.
   - Kiểm tra endpoint `/traffic-report/v2/html-export` với cả 3 mẫu báo cáo:
     - `PERIOD_ANALYSIS` (2026-08-01..2026-08-31): HTTP 200, size 1,046,005 bytes.
     - `WEEKLY_DETAIL` (2026-09-01..2026-09-07): HTTP 200, size 843,878 bytes.
     - `BAO_CAO_SAN_LUONG` (Mùa S26): HTTP 200, size 6,408,637 bytes.
2. **Kiểm tra tính bất biến của các endpoint phi HTML (Port 9001 vs Port 9003)**:
   - `/traffic-report/v1/dashboard-publication?year=2026`: Trùng khớp byte-for-byte (2,564 bytes).
   - `/traffic-report/v1/annual-kpi?year=2026`: Trùng khớp byte-for-byte (1,774 bytes).
   - Dọn dẹp container Canary an toàn.
3. **Thực thi Cutover & Khởi động lại dịch vụ Edge**:
   - Sao lưu cấu hình `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260913`.
   - Cập nhật mount trỏ về `/srv/seasonal-traffic-report/functions/20260913T073000Z-comprehensive-html-pivot-ux`.
   - Khởi động lại container `opsdata-traffic-report-edge` bằng Docker Compose.
   - Kiểm tra trạng thái port 9001: cả 4 endpoint phản hồi HTTP 200 OK.
4. **Kiểm thử tự động trên trình duyệt thật (Playwright Test trên HTML tải trực tiếp từ Production)**:
   - Tải file HTML thực tế từ public ingress `https://report.ahtops.xyz`:
     - `live-period.html` (1,046,372 bytes)
     - `live-weekly.html` (844,245 bytes)
     - `live-bao.html` (6,409,004 bytes)
   - Mở offline trên Microsoft Edge headless qua Playwright:
     - **0 lỗi JavaScript (`errors = []`)**.
     - Thời gian chuyển đổi giữa các tab: **1.60ms** (< 15ms).
     - Thanh tỷ trọng Data Bars: render thành công **1,299 ô**.
     - Cố định dòng tổng (`Grand Total`): `position: sticky` hoạt động hoàn hảo.

---

### 4. Hướng dẫn Rollback nhanh (khi cần thiết)

Nếu cần quay lại phiên bản Edge Functions trước đó ngay lập tức:

```bash
sudo cp /srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260913 /srv/seasonal-traffic-report/infra/docker-compose.yml
sudo docker compose -f /srv/seasonal-traffic-report/infra/docker-compose.yml up -d traffic-report-edge
```
