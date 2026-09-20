# Triển khai production: phân loại đúng va chạm Add Flight khi Full Replace (20260920230000)

Ngày 2026-09-20 (UTC+7). Migration: `app/supabase/migrations/20260920230000_seasonal_import_daily_guard_kind_classification.sql`
(`public.stage_seasonal_import_v3(jsonb)`).

## 1. Vấn đề

Guard trùng occurrence theo ngày lịch (`20260920170000_seasonal_import_daily_duplicate_guard.sql`) coi **mọi** row authority
đang active là "Daily leg". Ở chế độ Full Replace, dòng **Add Flight** (`source_kind='manual'`) do đó bị chặn nhưng báo sai:
`daily-occurrence-collision` với message "collides with an active Daily leg (…)".

Trước khi sửa, đo trên chuỗi migration khớp production (PGlite, `preDigest=31e99bb3fc2492b2493c0069eab7e0cd (34852)`):

```
production stage: valid=false status=failed codes=["daily-occurrence-collision"]
  message: Incoming occurrence collides with an active Daily leg
           (LEG_D_2027-02-02_314_JX_JX1702_TPE_16_05_320)…
  season rows sau stage: 2 (manual + daily, đều active)
```

## 2. Vì sao vẫn chặn, chỉ sửa phân loại

Đo trực tiếp: stage + commit **Full Replace** trên season 2 leg **không** reset leg của season — commit trả `committed`,
`importedRecordCount=1`, nhưng season rows đi từ **2 → 3** và dòng Daily lẫn dòng Add Flight vẫn active. Nghĩa là Replace
chèn cạnh các leg đang lưu chứ không xoá chúng.

Hệ quả: nếu bỏ chặn dòng Add Flight trong Replace thì file và dòng Add Flight cùng tồn tại cho một ngày lịch — đúng lỗi mà
guard sinh ra để ngăn. Bản nháp "kind-scope" (bỏ dòng manual khỏi candidate của Replace) đã bị **loại bỏ**; thay bằng bản
phân loại: manual vẫn chặn, nhưng báo đúng code `manual-occurrence-collision` và tính vào `manualCollisionCount`.

## 3. Thay đổi

- Candidate authority tách theo `source_kind`: dòng `manual` → `manual-occurrence-collision` (message "collides with a manual
  added flight."), các dòng authority khác (Daily store) → `daily-occurrence-collision` như cũ.
- Dòng manual được guard ở **cả** Merge và Replace (trước đây Merge dựa vào nhánh legacy `added`).
- `manualCollisionCount` được tính lại **sau** guard nên preview Replace phản ánh đúng.
- Client không cần đổi: `seasonalImportV3Contract.test.ts` đã có case `manual-occurrence-collision` + `manualCollisionCount`.

## 4. Rehearsal (PGlite)

- `preDigest 31e99bb3fc2492b2493c0069eab7e0cd (34852)` = preimage production; `postDigest 55b2d0a5360b70ac1d73cd8f70881821 (35490)`.
- Probe `verify_guard_kind.sql`: G1 merge+daily → daily code; G2 replace+daily → daily code; G3 merge+manual → manual code;
  G4 replace+manual → **manual code + `manualCollisionCount=1`**, 2 leg giữ nguyên; G5 file chứa cả hai row → cả hai code.
- Rollback rehearsal: pre → post → pre **byte-exact** (`31e99bb3…/34852`).
- Regression: `tmp/audit/w26/rollout/rehearse_verify.mjs` passed (P1–P5);
  `app/supabase/tests/seasonal_import_daily_duplicate_guard_pglite.mjs` 8 case passed.

## 5. Rollout production

- Apply bằng `psql -X -U supabase_admin -d postgres` (ON_ERROR_STOP=1) qua `tmp/audit/ssh_sql.py`.
- Pre-digest production `31e99bb3fc2492b2493c0069eab7e0cd (34852)`; post-digest `55b2d0a5360b70ac1d73cd8f70881821 (35490)`
  — khớp rehearsal.
- Probe hành vi trên production (đều `begin; … rollback;`):
  - **M1** Replace + dòng manual thật `F_NEW_1787795264779_18odiq_0` (2026-10-20): `valid=false`, `status=failed`,
    `codes=manual-occurrence-collision`, `manualCollisionCount=1`.
  - **M2** Replace + dòng Daily thật của S26 `DAILY_V2_50a5b39f64c70c175af62a56f90332ad` (2026-03-29): `codes=daily-occurrence-collision`.
  - **M3** `commit_seasonal_import_v3` trên batch `failed` bị từ chối (sqlstate `22023`); season rows `26741 → 26741`.
  - Rollback rehearsal (đúng bytes đã ship, transaction riêng): digest về `31e99bb3…/34852`, marker `0`, sau đó rollback —
    digest live vẫn `55b2d0a5…/35490`.
- Receipt: `/home/ops/seasonal-import-daily-guard-kind-classification-20260920/` (`migration.sql`, `rollback.sql`, `verify.sql`,
  `receipt.txt`, `SHA256SUMS`) — `sha256sum -c SHA256SUMS` trên host: tất cả `OK`.

## 6. Runbook

Mục **5.2** của `docs/runbooks/canonical-daily-seasonal-operations.md`: quy trình xử lý `manual-occurrence-collision`, kèm
ghi chú Full Replace **không** reset leg của season (2 → 3 dòng khi đo) để operator không chờ Replace tự dọn dòng Add Flight.

## 7. Việc còn lại của operator (dữ liệu, không phải code)

Season W26 hiện **không** có dòng Daily active (probe M2 phải lấy dòng của S26). Chặn còn lại trên đường import của operator
là va chạm với dòng Daily thật ở season tương ứng; xử lý theo mục 5.1 (thu hẹp `effective`/`discontinue` hoặc dọn dòng Daily
trước bằng flow repair/overlay delete), rồi stage lại bằng request ID mới.
