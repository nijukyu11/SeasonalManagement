# Biên bản phát hành Production: Tinh gọn Header và Điều hướng Báo cáo HTML Pivot

**Thời gian hoàn tất:** 13:30 ngày 17/09/2026 (Asia/Ho_Chi_Minh)  
**Phạm vi:** Phát hành chuyên biệt Edge Functions (Edge-functions-only). Tuyệt đối bảo toàn phiên bản UI tĩnh (`current`), database và Nginx.

---

### 1. Thông tin phiên bản & Lineage máy chủ

- **Mã phát hành (Release ID):** `20260917T063000Z-compact-header-ux`
- **Đường dẫn functions trên máy chủ:** `/srv/seasonal-traffic-report/functions/20260917T063000Z-compact-header-ux`
- **Nhánh Git & Worktree nguồn:** `codex/web-traffic-report` tại `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report` (Commit: `8b6b649`).
- **Bản Static UI hiện hành (Không chạm vào):**
  `/srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260912T062757Z-compact-sticky-bar`
- **Thành phần bất biến khác:**
  - Database schema & Materialized Views: Giữ nguyên 100%.
  - Cấu hình Nginx `/etc/nginx/conf.d/traffic-report.conf`: Giữ nguyên 100%.
  - Cấu hình cờ môi trường `/etc/seasonal-traffic-report/edge.env`: Giữ nguyên 100%.

---

### 2. Bảng mã băm SHA-256 đối soát byte-for-byte

Cây thư mục functions được sao chép từ release trước (`20260913T124500Z-html-pivot-ux-navigation-sync`) và cập nhật đúng 3 tệp tin trong `_shared/`:

| Tệp tin | SHA-256 Checksum | Trạng thái máy chủ |
| :--- | :--- | :--- |
| `_shared/trafficHtmlPivotStyles.ts` | `49b1f5c652a0ea2267415e5ce53ca102dd900af1cf35c32ea831b7506d5bb02f` | Khớp 100% |
| `_shared/trafficHtmlPivotRuntime.ts` | `1d537fda632612dd103b89855e891492c90e4bbf91207638057fefa86b63f793` | Khớp 100% |
| `_shared/trafficHtmlReportRenderer.ts` | `d44e1e379f981452dea02cdffa22f0e4cea97f3b78bbf7290a0aa52579d9cebd` | Khớp 100% |

---

### 3. Quy trình nghiệm thu an toàn đã thực hiện

1. **Kiểm tra Canary độc lập (Port 9003)**:
   - Khởi chạy container tạm thời `opsdata-traffic-report-edge-canary` trên port `9003`.
   - Đối soát tính bất biến của các endpoint phi HTML giữa port `9001` và port `9003`:
     - `/traffic-report/v1/dashboard-publication?year=2026`: Trùng khớp byte-for-byte (SHA-256: `4b4dcfa4fae45f2ae0c6a25149e8f7533b0c74a97a1f46dd4e3ce28283d85fdf`).
     - `/traffic-report/v1/annual-kpi?year=2026`: Trùng khớp byte-for-byte (SHA-256: `1dc5df4f45e971f1836c1366ed231374259872149b146aa15a511a5d503b3888`).
   - Kiểm tra xuất file HTML với cả 4 mẫu báo cáo:
     - `WEEKLY_DETAIL`: HTTP 200 (852.722 bytes).
     - `PERIOD_ANALYSIS`: HTTP 200 (10.810.023 bytes).
     - `BAO_CAO_SAN_LUONG`: HTTP 200 (6.412.209 bytes).
     - `MONTHLY_OVERVIEW_L2`: HTTP 200 (1.880.320 bytes).
   - Dọn dẹp container Canary an toàn.
2. **Thực thi Cutover có sao lưu**:
   - Sao lưu cấu hình `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260917`.
   - Cập nhật volume mount trỏ về `/srv/seasonal-traffic-report/functions/20260917T063000Z-compact-header-ux`.
   - Tái tạo và khởi động lại container `opsdata-traffic-report-edge` qua Docker Compose.
   - Container `opsdata-traffic-report-edge` khởi động Up thành công trên port `127.0.0.1:9001`.
3. **Smoke Test Ingress công khai (`https://report.ahtops.xyz`)**:
   - `https://report.ahtops.xyz/healthz` ➔ **HTTP 200 OK**.
   - `https://report.ahtops.xyz/reports/traffic` ➔ **HTTP 200 OK** (Last-Modified: 12/09/2026, bản UI tĩnh giữ nguyên 100%).
   - `https://report.ahtops.xyz/reports/traffic/dashboard` ➔ **HTTP 200 OK**.
   - Kiểm tra trực tiếp file HTML xuất ra từ production: xác nhận chứa `.header-main`, header thu gọn 59.3%, thanh tabs đơn hàng chống tràn ngang.

---

### 4. Hướng dẫn Rollback tức thì

Nếu cần quay lại phiên bản functions trước đó:

```bash
sudo cp /srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260917 /srv/seasonal-traffic-report/infra/docker-compose.yml
sudo docker compose -f /srv/seasonal-traffic-report/infra/docker-compose.yml up -d traffic-report-edge
```
