# Canonical overlay deletion authority — production rollout

Ngày: 2026-09-15 (Asia/Ho_Chi_Minh). Người dùng báo import Daily lỗi `Multiple active canonical records match the same Daily loose identity` sau fix "thêm chuyến mới" và yêu cầu kiểm tra lại cơ chế lõi cùng tình trạng DB production.

## 1. Triệu chứng và điều tra

- Lỗi staging Daily là `DAILY_LOOSE_IDENTITY_COLLISION` do `commit_daily_schedule_import_v1` phát hiện ≥2 canonical row **active** cùng loose identity. Nguồn dữ liệu: operator thêm tay một chuyến trùng với chuyến seasonal có sẵn, sau đó chọn xoá "toàn bộ nhóm chuyến" của chuyến đó.
- Truy vấn read-only trên production: thao tác xoá của operator chỉ ghi `season_modifications(action='deleted')`; **798 row** `season_flight_records` của W26 (2026-10-25 → 2027-03-28, gồm `LEG_A_*`, `LEG_D_*` và `F_NEW_1787300825247_yjogu1_0`) vẫn `status='active'` phía sau overlay, nên vẫn tính là canonical active và đụng loose identity với row thêm tay.
- Kiểm tra hai fix gần nhất: `0.1.28` (`7d79b14`) chỉ đổi `sourceKind` sang `manual` ở biên gửi mutation; `0.1.29` (`3f65beb`) chỉ đánh dấu chuyến tạo ở client là `added`, dịch `sourceKind` khi gửi và gửi kèm record đầy đủ khi Undo. Cả hai chỉ đổi payload phía client, không chạm bảng canonical và không chạm matcher.
- Đối chiếu DB: `0` row `deletion_reason='manual_undo'` (nhánh xoá manual của dispatcher chưa từng chạy), `0` row `status='deleted'` thiếu `deletion_reason`. Kết luận: fix gần nhất không gây sai sót DB; lỗi nằm ở seam xử lý overlay phía server.

## 2. Nguyên nhân gốc

`public.apply_workspace_op_json(text,jsonb)` (được `apply_season_server_mutation_v1` gọi cho mọi workspace op) xử lý `modification{action:'deleted'}` chỉ bằng `upsert_season_modification_from_json` — tức chỉ ghi overlay. Canonical store là authority cho import/export/duplicate check, nhưng lại **không** được cập nhật, nên:

- chuyến đã bị operator xoá vẫn là canonical row active ⇒ import thấy hai row active cùng loose identity ⇒ `DAILY_LOOSE_IDENTITY_COLLISION`;
- ngược lại, Undo của operator (gửi `modification{action:'modified'}`) cũng chỉ ghi overlay nên row đã xoá không được phục hồi nếu không có record op kèm theo.

## 3. Thay đổi

`app/supabase/migrations/20260915100000_canonical_overlay_deletion_authority.sql` — thay nhánh dispatch trong `apply_workspace_op_json` bằng semantics canonical đã có của `save_canonical_season_modification_v1` / `remove_canonical_season_modification_v1`:

- `modification{action:'deleted'}`: set `status='deleted'`, `action='deleted'`, `deletion_reason='overlay_deleted'`, `lifecycle_changed_*` trên row đang active, rồi mới ghi overlay (idempotent, chạy lại không đổi kết quả);
- `modification` khác (Undo): phục hồi row **chỉ khi** `is_rebasable_terminal_flight_leg_v1` — không hồi sinh row do import xoá, row đã bị supersede hay row nằm trong scope reset;
- `modificationDelete` (bỏ overlay): mirror `remove_canonical_season_modification_v1` — overlay `added` ⇒ `manual_undo`, overlay `deleted` ⇒ phục hồi row, sau đó xoá overlay;
- repair dữ liệu tồn đọng: 798 row đang active phía sau overlay `deleted` được chuyển sang trạng thái terminal chuẩn (`overlay_deleted`). Overlay được giữ nguyên vì đó là nguồn của thao tác Undo; không xoá row, không đổi cột nào khác.

Không đổi signature, không đổi bảng/cột, không cần release app.

## 4. Verification

- Rehearsal PGlite với chuỗi migration production: trước `110440719792cbab69d2925a105ac6c7` (khớp production), sau `c23e0c4709544701c8148b40cc49f5e2` (khớp production sau khi áp), rollback khôi phục **byte-identical** trạng thái trước và xoá comment hàm.
- Suite `app/supabase/tests/canonical_overlay_deletion_pglite.mjs` (mới) phủ: repair overlay tồn đọng, delete idempotent, Undo qua `modification`, `modificationDelete` hai nhánh, deletion do import sở hữu không bị hồi sinh, overlay legacy không có canonical row vẫn dispatch như cũ. Các suite liên quan (`test:canonical-flight-store`, `test:daily-canonical-commit`, `test:canonical-manual`, `test:seasonal-canonical-authority`, `test:seasonal-schema-twice`, `test:daily-import-sql`, `test:rules`) chạy lại sau migration.
- Probe production (mỗi probe chạy trong `BEGIN … ROLLBACK`, không ghi gì): xoá bằng `source='seasonal'` ⇒ terminal `overlay_deleted`; sửa từ route Daily cũ bị chặn `Flight … has been deleted; refresh server data before editing allocations`; `modificationDelete` ⇒ row active, overlay biến mất; Undo `modification{action:'modified'}` ⇒ row active trở lại. Sau repair: 798/798 row `is_rebasable_terminal_flight_leg_v1 = true`, `0` nhóm loose identity trùng trong active set, `0` row active phía sau overlay `deleted`.
- Digest sau khi áp trên production: `apply_workspace_op_json(text,jsonb)` = `c23e0c4709544701c8148b40cc49f5e2`.

## 5. Rollout

- Áp một transaction với `lock_timeout=15s`, `statement_timeout=300s`; `UPDATE 798` đúng tập row đã audit; commit 2026-09-15.
- Receipt trên server: `/home/ops/canonical-overlay-deletion-authority-20260915/{migration.sql,rollback.sql,receipt.txt}` kèm `SHA256SUMS`.
- Rollback: `rollback.sql` khôi phục định nghĩa dispatcher trước đó (byte-verified, giữ nguyên CRLF của thân hàm) và trả đúng 798 row về trạng thái trước repair.
- Không cần reload schema cache phụ thuộc, không cần phát hành app: thay đổi thuần database.

## 6. Việc còn lại cho người vận hành

- Stage lại file Daily đang lỗi: row thêm tay còn active sẽ thắng loose identity (không còn collision), phần seasonal bị xoá giữ nguyên tombstone nên không bị hồi sinh.
- Muốn cho chuyến đã xoá quay lại: dùng Undo trong app (hoặc `remove_canonical_season_modification_v1`) — không sửa row trực tiếp.
- Chưa thực hiện: cảnh báo trùng chuyến phía client khi thêm tay, để tránh operator tạo lại tình huống "hai chuyến cùng identity".
