# Xử lý dữ liệu trùng số hiệu/ngày (F07) trên production — S26

Ngày: 2026-09-19. Phạm vi: dữ liệu canonical S26 trên `opsdata-supabase-db` (`100.91.158.79`). Không đổi schema,
không đổi function, không deploy lại app/report.

## 1. Bối cảnh

Policy F07 ("một số hiệu chuyến bay chỉ xuất hiện một lần trong một ngày lịch") được siết từ
`2026-09-06-import-export-production-rollout.md`; stage Daily đã có guard `DAILY_DUPLICATE_FLIGHT_NUMBER`
(`20260906010000_import_terminal_coverage_and_identity.sql:89-101`). Tuy nhiên S26 còn 2 nhóm dữ liệu legacy vi phạm,
sinh bởi batch Daily `951b7261-e3a2-42f1-bc97-cd1ef158884e` (2026-08-31) — **trước** khi guard ra đời.

Hệ quả thực tế: gate export của Seasonal chặn workbook; trước 0.1.31 gate thêm chuyến còn quét cả mùa nên báo sai đối tượng
(`Add Flight Failed — Duplicate flight number NX985 on 2026-07-16` khi đang tạo JX). Client 0.1.31 đã chuyển sang gate scoped
(`2026-09-19-duplicate-gate-scoped-identity-0.1.31-release.md`, mục "Tồn đọng") nhưng dữ liệu vẫn cần xử lý để export sạch.

## 2. Chọn dòng nào để xoá (2 nhóm)

Audit toàn bộ 4 mùa (S25/S26/W25/W26) theo đúng filter của export snapshot: chỉ S26 có trùng, đúng 2 nhóm.

| Nhóm | Dòng | Ngày lịch | Ops | Nguồn | Quyết định |
| --- | --- | --- | --- | --- | --- |
| NX985 | `DAILY_V2_683bc249f07b683d1f458170207ab0cc` ARR 03:00 | 2026-07-16 | 2026-07-15 | Daily row 10588 | **xoá (soft)** |
| NX985 | `DAILY_V2_29e251fc978035f8404ddfb9b3753690` DEP 23:35 | 2026-07-16 | 2026-07-16 | Daily row 10322 | giữ |
| ZE593A | `DAILY_V2_0543601ccc0153abedbcbfdebd01f4dc` ARR 00:40 | 2026-07-27 | 2026-07-26 | Daily row 11205 | **xoá (soft)** |
| ZE593A | `DAILY_V2_93fe89588e3defafa6fd920c32fedb22` ARR 23:25 | 2026-07-27 | 2026-07-27 | Daily row 11377 | giữ |

Căn cứ:

- **NX985**: plan mùa chỉ có `NX985 DEP 23:35` cho toàn mùa (`LEG_D_2026-03-29_187_…` … `2026-10-24`); trong 210 dòng
  `NX985` active, dòng ARR 03:00 là **duy nhất** (209 dòng còn lại là DEP 23:35). Turn ops 2026-07-15 đã mất chiều DEP
  (file Daily ngày đó không có) nên dòng ARR còn lại là mảnh vụn, không thuộc plan.
- **ZE593A**: plan mùa giữ pattern đêm `ZE593 23:25` (139 dòng plan, 126 dòng active) và **không có** dòng plan nào cho
  turn sáng sớm 00:40/01:40 của ops 2026-07-26; dòng 23:25 cùng ngày (ops 2026-07-27) là dòng plan-backed và vẫn active,
  cặp DEP `ZE594 00:25` (2026-07-28) của nó cũng active. File Daily 2026-07-27 (`DAILY_FILE_CAL_20260727_ZE`) chứa cả hai
  ARR ⇒ đây là xung đột thật giữa 2 turn trong cùng ngày lịch, chọn theo plan.

Nguyên tắc chung: **giữ dòng plan-backed/pattern, xoá dòng Daily-only extra**; soft-delete (không hard delete) để giữ lineage
và rollback được.

## 3. Áp dụng

Migration: `app/supabase/migrations/20260919120000_duplicate_flight_day_repair.sql` (đã thêm vào chuỗi migration).
Một transaction, `lock_timeout=15s`, `statement_timeout=300s`:

- guard idempotent: season không tồn tại hoặc 2 dòng không còn active ⇒ `return`; chỉ 1 trong 2 active ⇒ `raise`
  (`preimage changed`);
- `update … set status='deleted', action='deleted', deletion_reason='duplicate_flight_day_repair',
  lifecycle_changed_at=clock_timestamp(), lifecycle_changed_by=null` (đúng hợp đồng terminal row của canonical store,
  `lifecycle_changed_by` để NULL như các đợt repair policy trước: `overlay_deleted`, `legacy_reconciliation`);
- assert `row_count=2` và số nhóm F07 trùng còn lại trong S26 = 0;
- bump `seasons.data_version` 16595 → 16596 (theo mẫu `20260723090000_normalize_season_modification_schedule.sql`).

Kết quả: `DO`, `COMMIT` lúc `2026-09-19 05:43:50Z`, đúng 2 row.

| Chỉ số | Trước | Sau |
| --- | --- | --- |
| S26 active / deleted | 25.233 / 41.905 | 25.231 / 41.907 |
| S26 data_version | 16.595 | 16.596 |
| Nhóm trùng F07 (4 mùa) | 2 | 0 |

## 4. Kiểm chứng

- **Rehearsal PGlite** (`app/supabase/tests/duplicate_flight_day_repair_pglite.mjs`, script `npm run test:duplicate-flight-day-repair`):
  chain mới trên DB trắng ⇒ no-op; fixture pre-state (2 cặp trùng + 3 row đối chứng) ⇒ repair xoá đúng 2 row, giữ nguyên
  sibling/control, version 16595→16596; chạy lại lần 2 ⇒ no-op, version không drift.
- **Post-check production**: 2 row `deleted/deleted/duplicate_flight_day_repair`, `lifecycle_changed_by=NULL`;
  F07 quét cả 4 mùa = 0 nhóm.
- **Gate thật end-to-end** (transaction rollback, `role authenticated` + `request.jwt.claim.sub` operator):
  `get_seasonal_export_snapshot_v2(...,16596)` → 25.231 record, 2 id đã xoá **không còn** trong payload;
  `get_season_workspace_snapshot(...)` → 67.138 record, 2 id ở trạng thái `deleted`.
  Chạy chính `app/src/lib/atomicSchedule.ts` (`findDuplicateFlightNumberViolations` + `assertNoDuplicateFlightNumbers`)
  trên 2 payload thật: **export 0 vi phạm, workspace 0 vi phạm**, cả 2 assert không throw ⇒ luồng "thêm chuyến" và "export"
  của app đã hết chặn.
- **Rollback probe**: chạy nguyên văn `rollback.sql` trong transaction rồi `rollback` ⇒ khôi phục đúng pre-state
  (`active`/`action=null`/`deletion_reason=null`/`lifecycle_changed_at=2026-08-31 10:32:31.628302+00`/`lifecycle_changed_by=0efc2bfe…`),
  `data_version` về 16.595; probe không persist.

## 5. Receipt

`/home/ops/duplicate-flight-day-repair-20260919/` — `migration.sql`, `rollback.sql`, `verify.sql`, `q_gate_probe.sql`,
`gate-probe.mjs`, `pre-row-*.json` (snapshot byte-exact 2 row), `post_verify.txt`, `gate_probe_summary.txt`, `receipt.txt`,
`SHA256SUMS` (đã `sha256sum -c` = OK).

Rollback: `python tmp/audit/ssh_sql.py < rollback.sql` (khôi phục 2 row byte-exact; chỉ hạ `data_version` khi chưa có
thay đổi khác).

## 6. Tồn đọng

- **Seasonal stage chưa có guard F07**: `stage_seasonal_import_v3` không có check tương đương `DAILY_DUPLICATE_FLIGHT_NUMBER`,
  nên workbook plan có 2 dòng cùng số hiệu trong cùng ngày lịch vẫn stage được ⇒ có thể tái tạo dữ liệu vi phạm.
  Đề xuất: thêm guard cùng ngữ nghĩa cho seasonal stage ở đợt sau (kèm rehearsal + receipt).
- **Export gate** giờ sạch với S26; gate vẫn chặn khi tập export có trùng (đúng thiết kế).
- **Report site** đọc canonical (`reporting.*` trên `public.season_flight_records`) nên thay đổi sẽ vào ở lần refresh kế tiếp;
  không cần refresh thủ công. Mỗi ngày lịch bị ảnh hưởng mất 1 leg (NX985 2026-07-16, ZE593A 2026-07-27) so với trước.
