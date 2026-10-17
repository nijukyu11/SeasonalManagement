# Rollout Artifact: Tối ưu hóa hiệu năng truy vấn Traffic Report & Dashboard qua Canonical Flight Legs Projection

- **Thời gian**: 2026-09-25 13:30 (GMT+7)
- **Máy chủ mục tiêu**: 100.91.158.79 (`opsdata-supabase-db`)
- **Tác vụ**:
  1. Chẩn đoán nguyên nhân Dashboard & Report chậm cập nhật sau khi import dữ liệu ngày 18-24.
  2. Kích hoạt và cập nhật đồng bộ cho dịch vụ background runner `seasonal-traffic-report-refresh`.
  3. Triển khai phân tách canonical flight legs projection và tăng tốc truy vấn hàm RPC `public.get_public_traffic_report_v2`.

---

## 1. Hiện trạng ban đầu & Nguyên nhân gốc rễ

1. **Dữ liệu Import**:
   - Dữ liệu ngày 18-24/09/2026 đã được import thành công vào cơ sở dữ liệu lúc 06:30 sáng (`daily-event:57449`), đầy đủ 847 chuyến bay và 133.991 lượt khách.
   - `reporting.public_traffic_daily_acceptance` cho ngày 2026-09-24 đạt trạng thái `ready` (coverage 100%, 0 missing pax).

2. **Nguyên nhân Dashboard không cập nhật ngay**:
   - Dịch vụ timer định kỳ `seasonal-traffic-report-refresh.timer` đang ở trạng thái `disabled` trên máy chủ từ ngày 20/09, khiến materialized view `reporting.public_traffic_effective` không tự động refresh sau import.
   - Khi watermark nguồn tăng từ 55107 lên 57449, view chưa được refresh nên dashboard runner từ chối tạo publication mới (`reason: projection_status, watermark, or data version is not current`).

3. **Nguyên nhân hàm RPC `get_public_traffic_report_v2` chậm (1.1 - 3.5 giây)**:
   - Hàm `get_public_traffic_report_v2` phải quét và chạy window function `row_number() over (partition by ... order by authoritative_server_seq desc)` trên toàn bộ 250k+ bản ghi của view materialized tổng hợp mỗi lần truy vấn.
   - Phép so sánh cùng kỳ năm trước (`comp=year_ago`) phải quét thêm một khoảng ngày của năm 2025, gây tải CPU và tăng thời gian phản hồi.

---

## 2. Các bước triển khai & Xử lý

### Bước 1: Kích hoạt & Refresh dữ liệu ngày 18-24
- Đã chạy manual refresh cho `reporting.public_traffic_effective`.
- `seasonal-traffic-dashboard-runner` ngay lập tức phát hiện trạng thái fresh và hoàn tất publication ngày 2026-09-24 thành công:
  - `publication_id`: 59
  - `status`: ready
  - `business_date`: 2026-09-24
  - `source_watermark`: 57449

### Bước 2: Tạo bảng Projection chuyên biệt `canonical_flight_legs`
- **Migration**: `20260925120000_public_traffic_canonical_legs_store.sql`
- **Nội dung**:
  - Tạo bảng `reporting.canonical_flight_legs` (251.827 dòng, 36 MB) và bảng `reporting.canonical_flight_legs_quarantine` có đánh chỉ mục trên `ops_date`.
  - Phân quyền nghiêm ngặt: thu hồi từ `anon`/`authenticated`, chỉ cấp quyền nội bộ cho `service_role`.
  - Tạo hàm `reporting.refresh_public_traffic_canonical_legs_v1()` để cập nhật dữ liệu.
  - Tích hợp hàm cập nhật này vào `/usr/local/sbin/seasonal-traffic-report-refresh`.

### Bước 3: Cắt chuyển (Cutover) hàm RPC `get_public_traffic_report_v2`
- **Migration**: `20260925121500_public_traffic_canonical_legs_acceleration.sql`
- **Đối soát MD5 an toàn (Strict Guard)**:
  - Pre-digest MD5: `425805e862bfd3e0551fa8d5c814ec4b`
  - Post-digest MD5: `cc32feac705426cdd309359e447e4bb0`
  - Rollback digest MD5: phục hồi chính xác 100% byte-exact về `425805e862bfd3e0551fa8d5c814ec4b`.
- Hàm mới đọc trực tiếp từ `canonical_flight_legs`, loại bỏ hoàn toàn chi phí tính toán candidate ranking và tính toán flight category on-the-fly.

---

## 3. Kết quả xác thực (Verification)

1. **Đối soát tính toàn vẹn dữ liệu (Data Parity)**:
   - Khoảng ngày 18/09/2026 - 24/09/2026:
     - Hiện tại: 847 chuyến bay, 423 đến, 424 đi, 133.991 lượt khách, 0 chuyến thiếu pax.
     - Kỳ so sánh: 849 chuyến bay, 428 đến, 421 đi, 128.754 lượt khách.
     - Khớp 100% từng byte dữ liệu JSON so với hàm gốc.

2. **Cải thiện thời gian phản hồi (Latency)**:
   - Endpoint `/api/report/v1/overview?from=2026-09-18&to=2026-09-24`: **~0.51 giây** (trước đây tính bằng nhiều giây).
   - Endpoint `/api/report/v1/overview?...&comp=year_ago`: **~0.50 giây** (trước đây > 3.5 giây).
   - Tốc độ tải trang Web Traffic Report: **~0.20 giây**.
   - Tốc độ tải trang Dashboard: **~0.21 giây**.

3. **Lưu trữ biên nhận trên máy chủ (Receipt on Host)**:
   - Thư mục: `/home/ops/canonical-legs-acceleration-20260925/`
   - Đã kiểm tra `sha256sum -c SHA256SUMS`: Tất cả các tệp đều trả về `OK`.
