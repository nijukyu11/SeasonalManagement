# Báo cáo triển khai: Ghép cặp 1:1 từ dữ liệu import Daily Schedule và dọn dẹp liên kết mồ côi

**Ngày thực hiện:** 2026-09-21  
**Mã migration:** `20260921020000_daily_schedule_1to1_pairing`  
**Host Production:** `100.91.158.79` (container `opsdata-supabase-db`)  
**Receipt ops host:** `/home/ops/daily-1to1-pairing-20260921/`  

---

## 1. Bối cảnh và Bản chất nghiệp vụ

Dữ liệu nạp từ lịch ngày (Daily Schedule Workbook - AMS) là **thước đo thực tế vận hành** (Ground Truth of Operations):
1. **Cặp được Link từ Daily (84.418 cặp trên 18 mùa / 8.180 cặp mùa S26):**
   - Khi một dòng trong file Excel Daily có đầy đủ cả chuyến Đến (`ARR`) và chuyến Đi (`DEP`) trên cùng số thứ tự dòng `source_row_number` (`arr_count = 1` và `dep_count = 1`), đây là một cặp quay đầu thực tế (turnaround pair).
   - Bao gồm các cặp cùng ngày (`sameday`) và các cặp qua đêm (`overnight` - đến tối ngày $T$, cất cánh ngày $T+1$).
   - Bao gồm cả các cặp ghép mới trong ngày (khác số hiệu, chuyến charter, chuyến đổi kế hoạch quay đầu).
2. **Chuyến bị Unlink từ Daily (47.811 chuyến đơn trên 18 mùa / 4.214 chuyến mùa S26):**
   - Khi một chuyến chỉ xuất hiện đơn lẻ một chiều trên dòng của file Daily (chiều kia bị hủy, ferry rỗng hoặc nằm sân), chuyến đó thực tế đã bị **Unlink**.
   - Chuyến bay phải được ghi nhận là chuyến đơn (`unpaired`), không có đối tác quay đầu, giữ `turnaround_id = null`, `linked_record_id = null`.
3. **Phòng vệ rã cặp qua đêm khi Replace theo khoảng ngày (Date-scoped replace):**
   - Khi import một dải ngày mới, nếu một cặp qua đêm có chặng Đến thuộc ngày bị xóa/thay thế nhưng chặng Đi nằm ngoài dải ngày, chặng Đi còn lại (survivor) phải được dọn dẹp sạch liên kết (`turnaround_id = null`, `linked_record_id = null`, `link_id = record_id`, `link_type = null`, `pair_anchor_date = null`) để tránh lỗi mồ côi (`missing-counterpart`).

---

## 2. Chi tiết kỹ thuật đã thực hiện

### Lớp 1: Cập nhật Stored Procedure `commit_daily_schedule_import_v1`
1. **Dọn dẹp liên kết mồ côi khi Delete/Replace:**
   - Sau lệnh xóa các chuyến trong `affected_dates`, tự động xóa metadata ghép cặp trên bất kỳ chuyến bay active nào còn sống sót bên ngoài `affected_dates` mà từng trỏ đến bản ghi vừa bị xóa.
2. **Ghép cặp 1:1 trực tiếp khi Insert:**
   - Sử dụng CTE `batch_row_pairs` gom nhóm theo `(batch_id, season_id, source_row_number)`.
   - Với các dòng có đúng 1 ARR và 1 DEP: ghi nhận đồng thời bộ 5 trường ghép cặp:
     - `turnaround_id` = `link_id` = `'TRN_DAILY_' || airline || '_' || arr_raw || '_' || dep_raw || '_' || arr_date || '_' || arr_id || '_' || dep_id`
     - `linked_record_id` trỏ chéo lẫn nhau giữa ARR và DEP.
     - `link_type`: `'overnight'` (nếu `dep_date > arr_date`) hoặc `'sameday'`.
     - `pair_anchor_date`: ngày của chuyến Đến (`arr_date`).
   - Với các dòng đơn lẻ: giữ nguyên các trường link là `NULL` và `link_id = canonical_record_id`.
3. **Dọn dẹp liên kết khi bị xóa bởi overlay:**
   - Nếu bản ghi trong batch bị đánh dấu xóa bởi `season_modifications` (`overlay_deleted`), lập tức dọn sạch liên kết trên chặng đối tác còn lại.

### Lớp 2: Backfill dữ liệu lịch sử và Tăng `data_version`
- Sử dụng bảng tạm `temp_daily_pairs` với điều kiện nghiêm ngặt:
  `having count(*) filter (where type = 'A') = 1 and count(*) filter (where type = 'D') = 1`
- Đã cập nhật chính xác **168.836 chặng bay Daily** (84.418 cặp quay đầu 1:1) trên toàn bộ 18 mùa.
- Tăng `data_version = data_version + 1` và `last_synced_at` trên toàn bộ 18 mùa để các client cập nhật cache.

---

## 3. Xác minh và Bằng chứng vận hành (Receipt)

1. **Kiểm tra tiêu hóa (Digests):**
   - Pre-digest (Preimage): `80dcc2d6edbe9d14a73f0c7321fda0ca`
   - Post-digest (Sau khi patch): `93d19f9acc19077f8da6ebb17a91442e`
   - Rollback digest (Khôi phục nguyên bản byte-exact): `80dcc2d6edbe9d14a73f0c7321fda0ca`
2. **Kiểm tra Rollback thực tế (Proven Rollback):**
   - Đã thực nghiệm rollback thành công với 168.836 bản ghi hoàn nguyên về null, digest khôi phục byte-exact.
   - Thử nghiệm trong transaction probe: hoàn nguyên 168.836 bản ghi và khôi phục trạng thái live an toàn tuyệt đối.
3. **Kiểm tra Export mùa S26:**
   - Dữ liệu trực tiếp từ DB live: `25.213` bản ghi active.
   - `resolveSeasonalPairs`: **9.757 cặp** (1.577 cặp mùa + 8.180 cặp Daily), **0 lỗi** (Zero issues).
   - `validateFlightLegsForSeasonalExport`: `valid: true`, **0 lỗi**.
   - `buildCanonicalSeasonalRows`: Tạo thành công **2.246 dòng lịch mùa chuẩn hóa**.
   - Các cặp quay đầu (như PR585/PR586 ngày 13/08/2026) được gom chung 1 dòng quay đầu đầy đủ STA/STD.
4. **Ops Host Receipt:**
   - Thư mục: `/home/ops/daily-1to1-pairing-20260921/`
   - Kết quả `sha256sum -c SHA256SUMS`:
     - `migration.sql: OK`
     - `rollback.sql: OK`
     - `receipt.txt: OK`
