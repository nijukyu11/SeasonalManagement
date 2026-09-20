# Triển khai production: gỡ chặn import trùng occurrence (20260920220000)

Ngày: 2026-09-20. Nối tiếp sự cố `Add Flight Failed — Duplicate flight number NX985 on 2026-07-16`
(`2026-09-19-duplicate-gate-scoped-identity-0.1.31-release.md`). Phần client đã có ở desktop `0.1.33`;
phiên này triển khai **phần database** — `app/supabase/migrations/20260920220000_seasonal_import_duplicate_resolution.sql`
— lên `opsdata-supabase-db` (host `100.91.158.79`, user `ops`).

## 1. Đã chạy gì trên production

Thứ tự đúng theo bundle `tmp/audit/w26/rollout/README.md`:

1. **Pre-state (read-only)** — `q_digests.sql`: 4 digest khớp bản ghi trong README, season S26
   `record_rows=67138`, `active_rows=25231`, `data_version=16596`.
2. **Pre-image byte-exact** — `q_dump.sql` (base64) → `build_rollback.py` → `rollback.sql`;
   md5 sau khi giải mã khớp cả 4 digest pre, nên rollback phục hồi đúng byte.
3. **Rehearsal** — `rehearse_verify.mjs` chạy `verify.sql` trên PGlite (`status: passed`).
4. **Apply** — chạy migration một lần, exit 0.
5. **Post-state + probe hành vi** — `q_digests.sql` + `verify.sql` (P1..P5, toàn bộ trong
   `begin; … rollback;`).
6. **Rollback rehearsal** — `rollback_probe.sql` chạy chính byte của `rollback.sql` trong một
   transaction riêng, assert 4 digest quay về pre rồi `rollback;`.
7. **Receipt** — `/home/ops/seasonal-import-duplicate-resolution-20260920/` với `sha256sum -c SHA256SUMS`
   trả về `OK` cho cả 15 tệp.

## 2. Bằng chứng digest (đo trên production)

| function | pre | post |
| --- | --- | --- |
| `seasonal_import_atomic_preview_v2(uuid)` | `2893f79aec30cbec00c0ec44870c7ffa` (24.470 B) | `9987a9adc58d7663876185ae49bf1882` (26.563 B) |
| `stage_seasonal_import_v2(jsonb)` | `3cfd475c428823d6e8807ab607ab93b4` (47.310 B) | `ae0692092af24660dee5e1ff07d1a2eb` (46.120 B) |
| `stage_seasonal_import_v3(jsonb)` | `9923e168ddf705b1a0fa50f6d59e80c1` (30.249 B) | `31e99bb3fc2492b2493c0069eab7e0cd` (34.852 B) |
| `seasonal_import_v3_response(uuid)` | `f6c413ad989a5dcbf780a87405c8aadb` (1.271 B) | `bbe8f218cb074fe2ee5cd9789e585731` (1.545 B) |

Cả 4 digest post **trùng khít** giá trị rehearsal PGlite. Chạy lại migration lần hai: guard
idempotence `duplicate-occurrence-resolved` chặn sớm, 4 digest không đổi.

Khác biệt duy nhất giữa chain local và production là kiểu xuống dòng của `seasonal_import_v3_response`:
file migration local lưu CRLF (`b2852ef7…`, 1.304 B), production lưu LF (`f6c413ad…`, 1.271 B) —
nội dung giống nhau sau chuẩn hoá `chr(13)||chr(10)` → `chr(10)` (đúng thứ mà migration so khớp),
và mọi body post đều LF nên so digest post trực tiếp được. Ba function còn lại khớp production ở dạng raw.

## 3. Probe hành vi (production, rollback toàn bộ)

`probe-transcript.txt` (exit 0):

- **P1** — file 2 dòng cùng occurrence: `valid=true`, `warnings=duplicate-occurrence-resolved`,
  `insertCount=1`, `kept row 1`.
- **P2** — dòng wide vs narrow: `valid=true`, `kept row 3`, `insertCount=7`.
- **P3** — dòng có operating days nằm ngoài window: cảnh báo `zero-generated-records`, `generated=1`.
- **P3b** — file không sinh được record nào: vẫn chặn, `valid=false`, code `zero-generated-records`
  đúng 6 field client parse.
- **P4** — chuyến Daily trùng: `daily-occurrence-collision`, guard vẫn chặn.
- **P5** — stage + commit: `status=committed`, `imported=4635`, `rows 67138 -> 67145`, và dòng
  persist là **dòng wide** (`source_row_index=3`, `schedule=09:15`) dù dòng narrow được liệt kê trước —
  tức `on conflict (occurrence_key) do nothing` không bao giờ gặp dòng thua.

Season S26 giữ nguyên `data_version=16596`, `record_rows=67138`, `active_rows=25231` sau rollout.

## 4. Rollback rehearsal

`rollback_probe_verbatim.sql` là **chính byte của `rollback.sql`**, chỉ thay `commit;` cuối bằng 4
assert digest + `rollback;` — nên `begin;`/`set local` và các câu `CREATE` của file đi qua scanner
của psql y nguyên (không bọc trong `DO`). Kết quả: `NOTICE: verbatim rollback.sql restored all four
raw pre-state digests`, exit 0, sau đó `ROLLBACK`.

Digest phục hồi là **raw pre** (giữ CRLF): `2893f79a…` (24.470 B), `3cfd475c…` (47.310 B),
`9923e168…` (30.249 B), `f6c413ad…` (1.271 B) — đúng giá trị `md5(pg_get_functiondef(...))` mà
production tự báo. Nếu rehearsal rơi vào bản chuẩn hoá LF (`f4ffd254…`/`a2697494…`) thì byte đã bị
viết lại ở đâu đó (transport hoặc wrapper), **không** phải do `CREATE FUNCTION` chuẩn hoá xuống dòng.
`rollback_probe.sql` là biến thể bọc `DO` trước đó, cùng assertion.

Sau rehearsal, chạy lại `q_digests.sql`: digest sống vẫn là post, season S26 vẫn
`data_version=16596` / `record_rows=67138` / `active_rows=25231` — rehearsal không để lại thay đổi nào.

## 5. Client và vận hành

- Field mới (`warningCount`/`warningsTruncated`/`warnings`) là additive; desktop `0.1.33` render
  "Resolved warnings" trong preview và chịu được server cũ. Desktop `<= 0.1.32` phải **khởi động lại**
  để updater lấy `0.1.33` trước lần import kế tiếp.
- `tmp/audit/ssh_sql.py` đã chuyển sang đọc stdin dạng byte (`sys.stdin.buffer`): chế độ text của
  Windows dịch CRLF → LF và âm thầm phá bản restore byte-exact. Giữ transport byte cho mọi SQL mang
  body function đã lưu.
- Bundle + receipt: `/home/ops/seasonal-import-duplicate-resolution-20260920/` (`receipt.txt`,
  `SHA256SUMS`, `migration.sql`, `rollback.sql`, `rollback_probe.sql`, `verify.sql`,
  `probe-transcript.txt`, `q_digests.sql`, `q_dump.sql`, `dump-pre.txt`, `build_rollback.py`,
  `rehearse_verify.mjs`, `probe-shape.mjs`, `probe-winner.mjs`,
  `seasonal_import_duplicate_resolution_pglite.mjs`, `README.md`).
