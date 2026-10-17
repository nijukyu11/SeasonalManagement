# Khắc phục lỗi Export Seasonal Schedule do chuyến bay Daily bị gán nhầm turnaround_id

**Ngày thực hiện:** 2026-09-21  
**Mã migration:** `20260921010000_daily_import_null_turnaround_id`  
**Host Production:** `100.91.158.79` (container `opsdata-supabase-db`)  
**Receipt ops host:** `/home/ops/daily-turnaround-id-null-repair-20260921/`

---

## 1. Hiện tượng và Nguyên nhân gốc

- **Hiện tượng:** Khi người dùng thực hiện thao tác Export Excel từ màn hình Seasonal Schedule (ví dụ mùa S26), hệ thống báo lỗi popup:
  ```text
  Cannot Export
  missing-counterpart: PR586 on 2026-08-13: PR586 on 2026-08-13 has no unique active counterpart.
  ```
- **Nguyên nhân cốt lõi:**
  1. Trong migration `commit_daily_schedule_import_v1` (tại các migration trước), câu lệnh `INSERT INTO public.season_flight_records` đã gán nhầm cột `turnaround_id` bằng giá trị `legs.loose_occurrence_key`.
  2. Giá trị này có dạng `S26|2026-08-13|DEP|PR|PR586` (chứa định danh chiều bay riêng rẽ `|DEP|` và `|ARR|`).
  3. Dữ liệu Daily Schedule (từ AMS) là các chuyến bay đơn lẻ theo chặng (leg), không có metadata cặp quay đầu như lịch mùa.
  4. Khi client gọi `resolveSeasonalPairs(activeLegs)` trước lúc export, hàm `hasPairingIntent` thấy `turnaroundId` khác `null` nên coi chuyến bay bắt buộc phải ghép được với một chuyến ngược chiều cùng `turnaroundId`. Do `turnaroundId` chứa nhãn `|DEP|` riêng, không bao giờ tìm thấy đối tác, dẫn đến phát sinh lỗi `missing-counterpart` trên toàn bộ 20.574 chuyến bay Daily của mùa S26.

---

## 2. Giải pháp thực hiện (2 lớp bảo vệ)

### Lớp 1: Khắc phục Database & Migration Production
- **Cập nhật function `commit_daily_schedule_import_v1`:**
  - Thay đổi giá trị chèn vào cột `turnaround_id` từ `legs.loose_occurrence_key` thành `null`.
  - Hàm đã được diễn tập (rehearsal) trong PGlite: pre-digest `ddda33b1ba9fd0970598131b5d843ce2`, post-digest `80dcc2d6edbe9d14a73f0c7321fda0ca`, rollback byte-exact khôi phục hoàn toàn preimage.
- **Sửa dữ liệu lịch sử:**
  - Cập nhật 248.397 dòng `source_kind = 'daily'` trên toàn bộ các mùa về `turnaround_id = null`.
  - Đã xác nhận không còn bất kỳ dòng Daily nào mang `turnaround_id` khác null.

### Lớp 2: Phòng vệ phía App Client (`app/src/lib/seasonalPairing.ts`)
- Bổ sung hàm `isTurnaroundId(id)`:
  - Nếu `id` chứa `|ARR|` hoặc `|DEP|`, không coi là `turnaroundId` hợp lệ.
- Trong `hasPairingIntent` và `turnaroundGroups`, chỉ các `turnaroundId` hợp lệ mới kích hoạt logic ghép cặp.
- Bổ sung 2 bộ test hồi quy tự động trong `seasonalPairing.test.ts` và `exporter.test.ts`.

---

## 3. Kết quả xác minh trên dữ liệu Production

Đã tải toàn bộ **25.213 bản ghi active** của mùa S26 từ Production về và chạy kiểm thử đường ống export:
- **Số lỗi ghép cặp (`resolveSeasonalPairs.issues`):** giảm từ **20.574 về 0**.
- **Số cặp turnaround:** bảo toàn nguyên vẹn **1.577 cặp** (3.154 legs) của dữ liệu mùa.
- **Số chuyến bay đơn lẻ (`unpaired`):** **22.059 legs** (toàn bộ các chuyến Daily được phân loại đúng là chuyến đơn, không còn bị chặn export).
- **Hợp thức export (`validateFlightLegsForSeasonalExport.valid`):** `true`.
- **Tổng số dòng Excel xuất ra (`buildCanonicalSeasonalRows`):** **2.981 dòng** hoàn chỉnh, không có bất kỳ lỗi nào.

---

## 4. Biên nhận triển khai (Ops Receipt)

```text
receipt_version: 1
migration_id: 20260921010000_daily_import_null_turnaround_id
target_host: 100.91.158.79
target_container: opsdata-supabase-db
database: postgres
applied_by: ops
applied_at: 2026-09-21T01:10:00Z
reason: "Fix seasonal export blocked by missing-counterpart on daily flights (e.g. PR586 on 2026-08-13)"

pre_migration_function_digest: ddda33b1ba9fd0970598131b5d843ce2
post_migration_function_digest: 80dcc2d6edbe9d14a73f0c7321fda0ca
rehearsed_rollback_function_digest: ddda33b1ba9fd0970598131b5d843ce2

records_updated: 248397
remaining_daily_with_turnaround_id: 0
s26_export_validation_valid: true
s26_export_rows_count: 2981
exit_code: 0
status: success
```
