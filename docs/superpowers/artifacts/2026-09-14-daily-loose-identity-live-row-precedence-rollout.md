# Daily loose identity — live row precedence, production rollout

Ngày: 2026-09-14 (Asia/Ho_Chi_Minh). Người dùng yêu cầu kiểm tra nghi vấn "fix thêm chuyến" làm hỏng import Daily và kiểm tra DB production.

## 1. Triệu chứng và điều tra

- Import Daily `LB_20260912_20260913.xlsx` stage `failed` với 2 diagnostic `DAILY_LOOSE_IDENTITY_COLLISION` tại row 28 và 90 (batch `bf179f1a-661d-40ed-9103-f42a2ecdbf8d`, sau đó bị cancel).
- Truy vấn read-only trên production cho thấy cặp row gây chặn là `KE2094 DEP PUS` ngày 2026-09-12/13: row manual **active** 15:20 `F_NEW_1785820606534_tuuorb_0/_1` (tạo 2026-08-04) và row manual **deleted** 14:50 `F_NEW_1784134154971_ujkh2g_0/_1` còn `deletion_reason='overlay_deleted'`.
- Kiểm tra hồi quy do fix "thêm chuyến": fix `0.1.29` (`3f65beb`) chỉ đổi client sang gửi `sourceKind='added'`/record đầy đủ cho Undo, `0.1.28` (`7d79b14`) chỉ chuyển `sourceKind` sang `manual` tại biên mutation. Không nhánh nào tạo row canonical và không nhánh nào chạm matcher.
- Đối chiếu DB: `0` nhóm active trùng loose identity ở mọi season; `0` row `status='deleted'` thiếu `deletion_reason`; write gần nhất 2026-09-12 là 262 seasonal bị `daily_replacement` + 242 daily active; mọi row `F_NEW_*`/`LEG_D_*` liên quan đều tạo trước 2026-08-29. Kết luận: fix gần nhất không gây sai sót DB; cặp row chặn là dữ liệu legacy từ tháng 7/8.

## 2. Nguyên nhân gốc

`public.stage_daily_schedule_import_v1(jsonb)` gom candidate theo loose identity, rồi:

- chặn khi `count(distinct occurrence_key) > 1`, và
- khi `count = 1` thì chọn row theo `lifecycle_changed_at desc nulls last` — tức ưu tiên **terminal row** (lifecycle do migration 2026-08-29 set) hơn **row active** (lifecycle null).

Hệ quả có hai lớp:

1. Chặn import (row 28/90): row active 15:20 khác occurrence key với terminal 14:50 ⇒ 2 key ⇒ `DAILY_LOOSE_IDENTITY_COLLISION`, dù chỉ có một chuyến thực sự đang bay.
2. Âm thầm ghi sai (đã tái hiện trên production cho ngày 2026-09-19): row active 14:50 và terminal seasonal 14:50 trùng occurrence key ⇒ `count = 1` ⇒ matcher chọn **terminal**, rebase modification `deleted` lên generation mới ⇒ leg trong file được insert **ở trạng thái cancelled** (`effectiveAfterCount` 0 dù file có chuyến), không có diagnostic nào.

## 3. Thay đổi

`app/supabase/migrations/20260914090000_daily_loose_identity_live_row_precedence.sql` — chỉ `create or replace` matcher của `stage_daily_schedule_import_v1(jsonb)`:

- đếm riêng candidate active và terminal;
- row active thắng: một active candidate ⇒ khớp row đó (không chặn, không kế thừa deletion cũ);
- giữ nguyên semantics deletion-carry khi chỉ có lineage terminal (một terminal ⇒ khớp terminal như cũ);
- chỉ chặn (`DAILY_LOOSE_IDENTITY_COLLISION`) khi có ≥2 row active, hoặc 0 row active mà >1 terminal khác occurrence key;
- ghi thêm `liveCandidateCount`/`terminalCandidateCount` vào `overlay_rebase_plan` của batch leg để hậu kiểm.

Không đổi cột dữ liệu, không backfill, không sửa row nào; `commit_daily_schedule_import_v1` không đổi.

## 4. Verification

- Regression: `app/supabase/tests/daily_schedule_canonical_commit_pglite.mjs` thêm scenario dựng đúng hình dạng production (active 15:20 + terminal 14:50; active 14:50 + terminal seasonal 14:50; hai row active 15:20/16:20). Bản không có migration fail (`status failed`, collision) — negative control chạy thật; có migration pass (`status validated`, matched = row active, `effectiveAfterCount` 1, commit giữ row daily active và không bị cancelled).
- Chuỗi migration dựng lại trong PGlite cho định nghĩa **byte-identical** với production trước khi sửa (`md5 c7926c8b8911fe8b09f53a72b56058f2`) và sau khi sửa (`1a0eecb07e60b750ab725a821a2e284c`); rollback SQL khôi phục đúng digest cũ.
- Suite pass: `test:daily-import-sql`, `test:canonical-flight-store`, `test:daily-canonical-commit`, `test:canonical-manual`, `test:seasonal-canonical-authority`, `test:seasonal-schema-twice`, `test:rules`.
- Probe production (chạy trong `BEGIN … ROLLBACK`, không ghi gì):
  - payload thật của batch `bf179f1a`: `validated`, collision 0 (trước: 2), `matchedCount` 247 (trước 245), KE2094 khớp `F_NEW_1785820606534_tuuorb_0/_1` với `liveCandidateCount 1`.
  - leg KE2094 ngày 2026-09-19: `effectiveAfterCount` 1 (trước 0), matched `F_NEW_1785821118927_x8e1vr_0` (row active).

## 5. Rollout

- Áp một transaction với `lock_timeout=5s`, `statement_timeout=120s`; assert định nghĩa mới + `commit_daily_schedule_import_v1` không đổi; commit lúc 2026-09-14.
- Receipt trên server: `/home/ops/daily-identity-live-row-precedence-20260914/{migration.sql,rollback.sql,receipt.txt}` kèm SHA-256.
- Rollback: chạy `rollback.sql` (khôi phục matcher cũ), không đụng dữ liệu.
- Không cần reload schema cache (chỉ `create or replace function`, không đổi signature) và không cần phát hành app: thay đổi thuần database.

## 6. Việc còn lại cho người vận hành

- Stage lại `LB_20260912_20260913.xlsx` trong app rồi commit; preview sẽ không còn blocking diagnostic.
- `effectiveAfterCount` 250 so với `afterCount` 251 là **đúng hợp đồng**: `VJ8020 DEP MNL 23:05` ngày 2026-09-12 có deletion overlay legacy (`overlay_deleted`) nên import không resurrect. Muốn cho chuyến bay lại, xoá modification deleted bằng flow canonical rồi stage lại (không sửa row trực tiếp).
