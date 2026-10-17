# Biên bản phát hành Production: Cải tiến Pivot HTML và Xuất dữ liệu đa chiều

**Thời gian hoàn tất:** 10:25 ngày 09/09/2026 (Asia/Ho_Chi_Minh)  
**Phạm vi:** Phát hành chuyên biệt Edge Functions (Edge-functions-only), hoàn toàn không sửa đổi static Next.js UI, database hay Nginx.

---

### 1. Thông tin phiên bản & Cam kết nhánh Git

- **Mã phát hành (Release ID):** `20260909T100000Z-html-pivot-improvements`
- **Đường dẫn functions trên máy chủ:** `/srv/seasonal-traffic-report/functions/20260909T100000Z-html-pivot-improvements`
- **Nhánh Git & Release Tag:** `codex/web-traffic-report` (Release ID: `20260909T100000Z-html-pivot-improvements`, Tag: `release-20260909T100000Z-html-pivot-improvements`).
- **Thành phần bất biến (Không chạm vào):**
  - Static release `/srv/seasonal-traffic-report/current`: Giữ nguyên bản `20260908T075606Z-report-cleanup`.
  - Database schema & Materialized Views: Giữ nguyên 100%.
  - Cấu hình Nginx `/etc/nginx/conf.d/traffic-report.conf`: Giữ nguyên 100%.
  - Cấu hình cờ môi trường `/etc/seasonal-traffic-report/edge.env`: Giữ nguyên 100%.

---

### 2. Bảng mã băm SHA-256 đối soát

Các file cập nhật trên máy chủ production khớp byte-for-byte với mã nguồn tại release tag `release-20260909T100000Z-html-pivot-improvements` (Release ID: `20260909T100000Z-html-pivot-improvements`):

| Tệp tin | SHA-256 Checksum | Trạng thái máy chủ |
| :--- | :--- | :--- |
| `_shared/trafficHtmlPivotRuntime.ts` | `4a1f683140c90f98dc21762913362648b113f60b82b25eef7d20f4014c9d819a` | Khớp 100% |
| `_shared/trafficHtmlPivotStyles.ts` | `1e39b40cd747ae67adda6750196e37c2f4b50867117f0abc606762139b64aa3c` | Khớp 100% |

---

### 3. Quy trình nghiệm thu an toàn đã thực hiện

1. **Kiểm tra Canary độc lập (Port 9003)**:
   - Khởi chạy container canary tạm thời trên port `9003`.
   - Kiểm tra endpoint `/traffic-report/v2/html-export` với các mẫu báo cáo (`PERIOD_ANALYSIS`, `BAO_CAO_SAN_LUONG`, `WEEKLY_DETAIL`): HTTP 200, phản hồi hợp lệ chứa đầy đủ runtime mới.
2. **Kiểm tra tính bất biến của các endpoint phi HTML (Port 9001 vs Port 9004)**:
   - Khởi chạy song song container baseline cũ trên port `9004`.
   - Đối soát endpoint `/traffic-report/v1/dashboard-publication?year=2026`: Phản hồi khớp **byte-for-byte (2.563 bytes)**.
   - Khẳng định 100% việc cập nhật 2 file runtime HTML không làm thay đổi bất kỳ hành vi nào của hệ thống dashboard hay API số liệu.
3. **Thực thi Cutover & Khởi động lại dịch vụ Edge**:
   - Sao lưu file cấu hình `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260909`.
   - Cập nhật mount trỏ về thư mục phát hành mới và khởi tạo lại `opsdata-traffic-report-edge`.
4. **Kiểm thử tự động trên trình duyệt thật (Playwright Offline Test trên HTML Production)**:
   - Tải file HTML thực tế từ production live về máy:
     - `PERIOD_ANALYSIS` (577.300 bytes)
     - `WEEKLY_DETAIL` (823.802 bytes)
     - `BAO_CAO_SAN_LUONG` (6.393.830 bytes)
   - Mở offline trên Edge headless qua script `test-production-live-html.mjs` (yêu cầu biến môi trường `TRAFFIC_BROWSER_RUNTIME` trỏ tới Playwright runtime hoặc môi trường đã cài sẵn Playwright, ví dụ: `TRAFFIC_BROWSER_RUNTIME=".../playwright/package.json" node --experimental-strip-types scripts/test-production-live-html.mjs`; trong khi đó bộ test `test:traffic-pivot-improvements` chạy bằng Node.js test runner thuần túy không cần bất kỳ dependency bên ngoài nào):
     - **Không có bất kỳ lỗi JavaScript nào (`pageerror = 0`)**.
     - Thao tác chọn Mẫu Pivot nhanh (`Thị trường × Tháng`, `Chặng bay × Chiều`) phản hồi tức thì.
     - Sao chép vào Clipboard tạo chuỗi TSV chuẩn xác.
     - Xuất file CSV: Khẳng định 100% tính chữ nhật của lưới dữ liệu (mọi hàng đều có 8 cột cho bảng tuần và 9 cột cho bảng ngày, không lệch cột).
     - Bảo toàn số âm: Giá trị âm (`-36`, `-85,7%`) xuất dạng số, không bị chèn dấu nháy đơn.
     - Khử độc công thức: Nhãn bắt đầu bằng dấu công thức nguy hiểm (`=CMD`) được vô hiệu hóa an toàn thành `'=CMD`.

---

### 4. Hướng dẫn Rollback nhanh (khi cần thiết)

Nếu cần quay lại phiên bản Edge Functions trước đó ngay lập tức:

```bash
sudo cp /srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260909 /srv/seasonal-traffic-report/infra/docker-compose.yml
sudo docker compose -f /srv/seasonal-traffic-report/infra/docker-compose.yml up -d traffic-report-edge
```
