# Triển khai production: Cho phép Season Replace thay thế Add Flight trùng lịch (20260920235500)

Ngày 2026-09-20 (UTC+7). Migration: `app/supabase/migrations/20260920235500_seasonal_replace_selective_manual_supersede.sql`.
Các hàm cập nhật: `public.stage_seasonal_import_v3(jsonb)` và `public.commit_seasonal_import_v3(uuid, integer, text)`.

## 1. Bối cảnh & Vấn đề

1. Khi người dùng thực hiện **Season Repair / Replace All** (ví dụ nạp file `W26_SeasonalSchedule.xlsx`), file mùa chính thức có thể chứa các chuyến bay mà trước đó người dùng từng tạo thủ công tạm thời (`source_kind = 'manual'`), ví dụ hãng JX (`JX1702`).
2. Guard trước đây coi va chạm với dòng thủ công là lỗi chặn (`manual-occurrence-collision`), khiến toàn bộ file mùa bị từ chối (`valid = false`).
3. Ngược lại, nếu xoá hàng loạt toàn bộ dòng thủ công khi Replace thì các dòng Add Flight không liên quan (không trùng với file) sẽ bị mất oan (vi phạm invariant của `seasonal_rebuild_daily_authority_pglite.mjs` vốn yêu cầu giữ lại các dòng manual không trùng).

## 2. Giải pháp

1. **Ở hàm `stage_seasonal_import_v3`**:
   - `manual-occurrence-collision` chỉ áp dụng khi `v_strategy = 'merge'`.
   - Khi `v_strategy = 'replace'`, dòng manual trùng lịch với file không còn bị coi là lỗi chặn (nhường chỗ cho dữ liệu chính thức từ file mùa mới).
   - Va chạm với lịch Daily (`daily-occurrence-collision`) vẫn được bảo vệ nghiêm ngặt ở cả 2 chế độ.
2. **Ở hàm `commit_seasonal_import_v3`**:
   - Khi `apply_strategy = 'replace'`, bên cạnh các dòng `seasonal` cũ, hệ thống tìm các dòng `manual` đang active có trùng `occurrence_key` với các bản ghi được commit từ file và chuyển chúng sang `status = 'deleted'`, `action = 'deleted'`, `deletion_reason = 'seasonal_rebuild'`.
   - Các dòng `manual` không trùng lịch vẫn giữ nguyên trạng thái `active`.

## 3. Đo đạc & Kiểm thử Rehearsal

- **Pre-digests (production raw)**:
  - `stage_seasonal_import_v3`: `55b2d0a5360b70ac1d73cd8f70881821` (len: 35490)
  - `commit_seasonal_import_v3`: `dab9c6a0204ea7d562bae68bbea260c7` (len: 46705)
- **Post-digests (production live)**:
  - `stage_seasonal_import_v3`: `f4d81f4933498b11645ecaa3a260d533` (len: 35558)
  - `commit_seasonal_import_v3`: `4c09f7d50030b935bf297409f03c668c` (len: 47485)
- **Rollback rehearsal**: Pre-digest và restored-digest khôi phục byte-exact 100%.

## 4. Kiểm thử thực tế trên Production với file W26 (In-tx probe — ĐÃ ROLLBACK)

- File: `C:\Users\tuan\Downloads\W26_SeasonalSchedule.xlsx` (25.992 occurrences).
- Kết quả stage trong transaction: `valid = true`, `status = validated`, `manual_collisions = 0`.
- Kết quả commit trong transaction: `status = committed`.
- Số lượng dòng manual trong transaction kiểm thử:
  - Trước commit: 190 dòng active.
  - Sau commit: 166 dòng active (24 dòng `JX1702` trùng lịch chuyển sang `seasonal_rebuild`, 3 dòng `JX1702` không trùng lịch và 163 dòng thủ công khác giữ `active`).
- **Ghi chú quan trọng về dữ liệu**: Toàn bộ transaction kiểm thử dữ liệu đã được `ROLLBACK` sạch sẽ.
- Dữ liệu production thực tế hiện tại được bảo toàn nguyên trạng:
  - Mùa W26: `manual active = 190`, `seasonal active = 25753`.
  - Người dùng có thể tự thực hiện nạp/Season Repair trực tiếp từ giao diện bất cứ lúc nào.

## 5. Ops Host Receipt

Bundle receipt đầy đủ đã được đẩy lên ops host tại:
`/home/ops/seasonal-replace-selective-manual-supersede-20260920/`:
- `migration.sql` (5.0 KB)
- `rollback.sql` (3.8 KB)
- `receipt.txt` (2.4 KB)
- `SHA256SUMS` (Đã verify: `OK`)
