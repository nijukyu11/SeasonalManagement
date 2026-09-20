# Guard F07 cho stage import Seasonal (`daily-occurrence-collision`)

Ngày: 2026-09-20. Phạm vi: function `public.stage_seasonal_import_v3(jsonb)` trên `opsdata-supabase-db`
(`100.91.158.79`). Không đổi schema bảng, không đổi dữ liệu, không cần deploy lại app/report.

Đợt này đóng tồn đọng #1 của `2026-09-19-duplicate-flight-day-data-repair.md`.

## 1. Bối cảnh

Policy F07 ("một số hiệu chuyến bay chỉ xuất hiện một lần trong một ngày lịch") đã có guard cho stage **Daily**
(`DAILY_DUPLICATE_FLIGHT_NUMBER`) nhưng chưa có guard tương đương cho stage **Seasonal**. Hệ quả: một file plan Excel
có occurrence trùng `(ngày lịch, airline, số hiệu chuẩn hoá)` với một dòng Daily **đang active** vẫn stage sạch và commit
được ⇒ tạo lại đúng loại dữ liệu đã gây sự cố `Add Flight Failed — Duplicate flight number NX985 on 2026-07-16`.

## 2. Nguyên nhân gốc (đã kiểm chứng bằng probe production trước khi patch)

`stage_seasonal_import_v3` đã có guard `duplicate-occurrence-key` nhưng guard này chỉ:

- so **trong cùng file** (group theo `season|resolved_scheduled_date|airline|normalized_flight_number`), và
- so với các dòng plan (`existing_source` = `source_kind='seasonal'` sau `20260829170000_seasonal_canonical_authority.sql`).

Nó **không** so với dòng Daily đang active — mà Daily là authority cho ngày đã có dữ liệu thực tế. Probe trước patch
(transaction rollback, `role authenticated` + JWT operator):

| Probe | Input | Kết quả trước patch |
| --- | --- | --- |
| A | 2 leg cùng số hiệu/cùng ngày **trong file** | `valid=false`, `duplicate-occurrence-key` (guard cũ chạy đúng) |
| B | plan `NX985 ARR 03:00` ngày `2026-07-16` cạnh Daily `NX985 DEP 23:35` cùng ngày | `valid=true`, `insertCount=1`, **không diagnostic** ⇒ commit sẽ tạo dòng active thứ 2 |

Đối tượng Daily trong probe B chính là `DAILY_V2_29e251fc978035f8404ddfb9b3753690` (dòng được giữ lại trong đợt repair
2026-09-19) ⇒ khe hở này tái tạo được sự cố cũ bằng một lần import plan.

## 3. Thay đổi

Migration: `app/supabase/migrations/20260920170000_seasonal_import_daily_duplicate_guard.sql`
(patch `pg_get_functiondef` + `replace` một anchor duy nhất, đúng khuôn `20260915100000_canonical_overlay_deletion_authority.sql`).

- Thêm CTE `daily_candidates` / `daily_occurrences` và insert diagnostic mới vào bảng diagnostic của stage:
  - code: `daily-occurrence-collision`
  - message: `Incoming occurrence collides with an active Daily leg (<record_id>): each flight number may appear only once within a calendar day.`
- Candidate = `season_flight_records` có `status='active'`, `action is distinct from 'deleted'`, **không** có overlay
  `season_modifications.action='deleted'`, `source_kind not in ('seasonal','imported','added')`, `action is distinct from 'added'`,
  và với `merge` thì loại `source_kind='manual'` (đã có `manual-occurrence-collision` riêng), với `replace` thì gồm cả `manual`.
- Áp dụng cho cả `merge` và `replace`; dòng overlay-deleted không tính (không còn active).
- Diagnostic nằm trong bảng diagnostic chung ⇒ `v_diagnostic_count > 0` ⇒ `valid=false` ⇒ batch `status='failed'`
  ⇒ `commit_seasonal_import_v3` từ chối (không cần sửa commit).
- Guard vận hành: `begin` + `lock_timeout=15s` + `statement_timeout=300s` + marker idempotence
  (`position('daily-occurrence-collision' in pg_get_functiondef(...)) > 0` ⇒ `return`) + assert anchor + assert hậu replace.

## 4. Kiểm chứng

**Rehearsal PGlite** — `app/supabase/tests/seasonal_import_daily_duplicate_guard_pglite.mjs`
(`npm run test:seasonal-import-daily-duplicate-guard`) + `..._parity.mjs`:

| Chỉ số | Trước patch | Sau patch |
| --- | --- | --- |
| `md5(pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'))` | `6cad4bcc172bc6d267bda4c13d5a0d07` (27.710 bytes) | `9923e168ddf705b1a0fa50f6d59e80c1` (30.249 bytes) |

- Chain rehearsal: `schema.sql` + 17 migration 20260828…20260915 + migration này (chạy 2 lần). Digest PRE của rehearsal
  **trùng byte-exact** digest production trước patch; chạy migration lần 2 không đổi digest.
- 8 case hành vi pass: collision vs Daily active (ARR & DEP); dòng Daily overlay-deleted không collision; dòng seasonal
  cùng key là update (`baselineUpdateCount=1`); manual giữ code riêng; trùng trong file vẫn `duplicate-occurrence-key`;
  số hiệu không tồn tại ⇒ `valid=true`; `replace` cũng bị chặn; chạy lại migration không mất guard.
- Rollback rehearsal (`rollback.sql` bytes): digest về đúng PRE byte-exact.
- Suite cũ `npm run test:seasonal-import-v3-sql` (chain 20260718…20260818 + migration này chạy 2 lần): pass toàn bộ
  scenario permission/replace/overlay/identity, không phát sinh diagnostic mới.

**Production** (`python tmp/audit/ssh_sql.py < migration.sql`): `DO`/`COMMENT`/`COMMIT` lúc 2026-09-20; digest sau patch
`9923e168…` **trùng rehearsal**; comment function mới (trước đó không có comment).

**Probe hành vi trên production** (tất cả trong transaction rollback, `verify.sql` + `commit_gate_probe.sql`):

| Probe | Input | Kết quả sau patch |
| --- | --- | --- |
| A | 2 leg cùng số hiệu/cùng ngày trong file | `valid=false`, `duplicate-occurrence-key` |
| B | plan `NX985 ARR 03:00` `2026-07-16` | `valid=false`, `daily-occurrence-collision` (nêu đúng `DAILY_V2_29e251fc…`) |
| C | plan `NX985 DEP 23:35` `2026-07-16` | `valid=false`, `daily-occurrence-collision` |
| D | số hiệu không tồn tại (`NX999`) | `valid=true`, không diagnostic (guard không chặn tràn lan) |
| E | plan `NX985 DEP 23:35` `2026-10-01` trùng occurrence seasonal đang active | `valid=true`, `baselineUpdateCount=1` (re-import plan hợp lệ không bị chặn) |
| F | `replace` với leg trùng Daily | `valid=false`, `daily-occurrence-collision` |

- **Commit gate end-to-end**: stage leg trùng Daily ⇒ `status=failed`, `valid=false`, `diagnosticCount=1`;
  `commit_seasonal_import_v3(batchId, 16596, previewHash)` ⇒ bị chặn (`sqlstate=22023`,
  "must be validated before commit; current status is failed"); số dòng season trước/sau `67.138 / 67.138` (không ghi dữ liệu).
- **Rollback probe production**: chạy nguyên văn `rollback.sql` (bỏ `begin`/`commit`) trong transaction ⇒ digest về
  `6cad4bcc…`, comment `<none>`, guard biến mất; transaction rollback nên digest live vẫn `9923e168…`.
- **Trạng thái F07 live**: 0 nhóm trùng `(date|airline|số hiệu)` trên toàn bộ season active; S26 `data_version=16596`,
  67.138 dòng (25.231 active) — không đổi so với sau đợt repair 2026-09-19.

## 5. Receipt

`/home/ops/seasonal-import-daily-duplicate-guard-20260920/` — `migration.sql`, `rollback.sql`, `verify.sql`,
`commit_gate_probe.sql`, `rollback_probe.sql`, 2 file test PGlite (copy), `receipt.txt`, `SHA256SUMS`
(đã `sha256sum -c` = OK).

Rollback: `python tmp/audit/ssh_sql.py < rollback.sql` (khôi phục definition gốc byte-exact + xoá comment).

## 6. Ảnh hưởng vận hành

- Từ nay một file plan có occurrence trùng `(ngày lịch, số hiệu)` với một dòng **Daily đang active** sẽ bị chặn ở bước
  preview (batch `failed`). Cách xử lý đúng: thu hẹp `effective`/`discontinue` của file plan để không phủ các ngày đã có
  dòng Daily (Daily là authority), hoặc xử lý dòng Daily trước nếu plan phải thay thế.
- Không đổi client: dialog `Seasonal import preview` hiển thị diagnostic theo nhóm code như các diagnostic cũ, nút commit
  đã bị chặn sẵn khi `valid=false`.
- Báo cáo/report site không bị ảnh hưởng (chỉ đổi đường stage import).

## 7. Tồn đọng

- Guard so theo **ngày lịch** (`coalesce(scheduled_date, date)`) và **số hiệu chuẩn hoá** — không xét `operational_date`;
  đúng ngữ nghĩa F07 hiện hành nhưng nếu sau này F07 đổi sang ops date thì guard Daily và Seasonal phải đổi cùng nhau.
- Chưa có guard tương đương ở đường **commit** cho các batch đã stage hợp lệ **trước** khi patch (batch cũ hết hạn sau 24h;
  hiện tại không có batch `validated` nào tồn đọng — đã kiểm tra trước khi patch).
- Client chưa có nhãn tiếng Việt riêng cho code `daily-occurrence-collision` (dialog hiển thị code + message tiếng Anh như
  mọi diagnostic server khác).
