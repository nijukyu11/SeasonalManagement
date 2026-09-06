# Import/export hardening — production rollout

Ngày: 2026-09-06 (Asia/Ho_Chi_Minh). Người dùng đã phê duyệt áp migration và deploy production.

## Phạm vi

- Source commit: `f8d2eb36220126b3b3e579d318e1dfd72bd284d7`.
- Desktop patch: `0.1.27`, tag `app-v0.1.27`.
- Không import workbook thật, reset, backfill hoặc sửa dữ liệu chuyến bay production.
- Không deploy lại website Report, Edge function, Nginx hoặc các thay đổi Dashboard/Report chưa commit của người dùng.

## Database

Đã áp thành công trên `opsdata-supabase-db`, PostgreSQL 17.6, database `postgres`, owner `supabase_admin`:

1. `20260904183000_daily_import_stage_indexed_ops_date.sql`
2. `20260906010000_import_terminal_coverage_and_identity.sql`
3. `20260906011000_active_seasonal_export_snapshot.sql`

Gộp ba migration trong một transaction; `lock_timeout=5s`, `statement_timeout=120s`; reload schema cache PostgREST sau commit. Hotfix indexed Ops Date đã có được nhận diện và bỏ qua an toàn.

Server không có `supabase_migrations.schema_migrations`. Không tự tạo ledger mới: receipt, SQL, checksum và định nghĩa rollback được lưu tại `/home/ops/seasonal-hardening-20260906`.

Backup đầy đủ trước rollout: `pre-hardening.dump`, SHA-256:

`d00f89b47e8cd8662ebc1fabaa1451e5d770529245a502804e71f69653ae8e2d`

Rollback RPC: `postgres-rollback.sql`, SHA-256:

`e720b44c2934a1ff22883f8cda0fca96c19eeca8209d8706c763feafb1f2099a`

Rehearsal đã kiểm chứng khôi phục định nghĩa cũ và áp lại migration trên clone trước khi chạy production. Rollback không khôi phục dữ liệu bằng dump và không được chạy riêng một phía client/SQL nếu đã phát sinh import theo contract mới.

## Invariants trước/sau

Tất cả so sánh khớp:

| Chỉ số | Trước = sau |
| --- | --- |
| Flight records / canonical active | 122127 / 67129 |
| Digest toàn bộ flight records, bao gồm Pax | `e9395402ed95bf6871cff75e3367f832` |
| Modifications / digest | 7451 / `6cefe53f01c9519d72f62b113cc8193f` |
| Replacement scopes / digest | 247 / `d12798b55facf63c0e3d85a929a0986e` |
| Audit events / high-water | 50560 / 50932 |
| Daily batches / committed | 16 / 13 |
| Versions S25 / S26 / W25 / W26 | 4 / 16585 / 8232 / 399 |
| Report projection | fresh; watermark 50932; snapshot_rows 67123 |

Active base count và report effective count có thể khác do overlay; rollout không làm thay đổi chênh lệch có sẵn này và không coi hai đại lượng là cùng một count.

### Dữ liệu lịch sử cần quyết định riêng

Hậu kiểm theo policy F07 mới phát hiện 2 nhóm cùng airline/flight/calendar-date đã tồn tại trước rollout (digest dữ liệu trước/sau khớp):

- S26, 2026-07-16, `NX985`: ARR 03:00 và DEP 23:35, route MFM.
- S26, 2026-07-27, `ZE593A`: ARR 00:40 và ARR 23:25, route ICN.

Cả bốn row đều Daily active, action null; đây không phải history/superseded action bị lọt export. Chúng khác atomic occurrence theo giờ/side và tồn tại từ các import cũ. Rule import mới chặn duplicate flight-day trong file, không tự backfill hoặc xoá những row cũ này. Cần audit nguồn và phê duyệt data repair riêng nếu muốn toàn bộ dữ liệu lịch sử tuân thủ policy F07.

## Verification

- Clone PostgreSQL từ backup production: migration pass, invariants giữ nguyên, rollback rồi reapply pass.
- Đã dọn ba database rehearsal do đợt rollout tạo sau khi test xong (khoảng 2,2 GB); giữ backup, migration, log và rollback SQL để có thể tái dựng.
- Hai suite Daily canonical commit và Seasonal rebuild authority chạy lại qua `pg` trên các database clone riêng: pass. Gồm failpoint rollback, idempotency, zero-flight, multi-season, duplicate, terminal deletion, Undo, repeated Merge và authenticated export.
- Adapter rehearsal chỉ bỏ bootstrap PGlite/migrations vì dùng schema clone đã áp; đổi truy vấn fixture legacy `effective_flight_operations.ops_date` sang tên hiện hành `operational_date`. Không thay RPC để làm test pass.
- Smoke export production bằng role `authenticated`: S25=3, S26=25344, W25=15229, W26=26553; không có inactive/deleted action; record IDs không trùng; `totalCount` khớp arrays. Stale version trả PT409.
- ACL production: authenticated gọi được stage/commit/export; anon không được EXECUTE. Hai helper nội bộ mới không được authenticated/anon EXECUTE.
- HTTP qua Kong/PostgREST: Workspace `all`, `checkin`, `gate` đều 200; export S25 200; stale export 409/PT409 ~25 ms; stale Daily stage 409/PT409 ~4 ms, không lưu batch.
- Public URL bằng curl: `/reports/traffic` và `/reports/traffic/dashboard` 200; `/api/report/v1/dashboard-version?year=2026` fresh tại watermark 50932. Python urllib từ server bị 403 nên không dùng probe đó làm bằng chứng public acceptance. Route có trailing slash không phải URL canonical của bản static hiện hành.
- Local sau bump: Daily 30/30, updater 8/8. Các kết quả build/typecheck/lint/regression đầy đủ trước rollout nằm trong artifact hardening.

## Desktop release

GitHub Actions run: `33999495588`, completed / success.

Đã phát hành lúc `2026-09-05T23:58:41Z` (06:58 ngày 06/09 giờ Việt Nam). Build signed Tauri bundle và publish đã pass.

- Installer: `SeasonalManagement_0.1.27_x64-setup.exe`, 22797374 bytes.
- SHA-256: `dd0ec7d3fa9d05141e42043561e098c8be8653f7867d2d8cb03a03b162044f3e`, khớp digest GitHub asset.
- Đã tải installer và `.sig`; xác minh chữ ký Ed25519/Minisign bằng public key trong `tauri.conf.json`: pass.
- Signature trong manifest khớp `.sig`; version và installer URL trỏ đúng `app-v0.1.27`.
- Public updater endpoint `/releases/latest/download/latest.json` trả version `0.1.27`.
- Release: https://github.com/nijukyu11/SeasonalManagement/releases/tag/app-v0.1.27

Nghiệm thu thao tác thật trong Tauri và import workbook production không được thực hiện trong đợt rollout này. Sau khi cài bản mới, preview chưa commit từ contract cũ phải stage lại; receipt đã committed vẫn idempotent.
