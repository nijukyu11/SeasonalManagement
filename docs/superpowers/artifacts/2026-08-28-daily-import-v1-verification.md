# Daily Schedule Import V1 — kết quả triển khai và verification

**Ngày kiểm chứng:** 2026-08-28; production rollout 2026-08-29

**Branch:** `codex/daily-import-v1`

**Phạm vi:** local source/PGlite/native tests, read-only shadow, PostgreSQL 17 clone rehearsal, production migration và một controlled import file LB thật.

## Kết luận

Luồng Daily Schedule cũ đã được thay bằng staged import V1 cho cả hai layout workbook. File được chuẩn hóa thành canonical legs, stage để xem chính xác season/Ops Date/count, rồi mới được commit bằng một PostgreSQL transaction. Commit không delete Seasonal baseline; nó đổi active Daily pointer theo từng Ops Date. Workspace allocation, Daily/Gate/Check-in và reporting đọc effective Daily snapshot cho ngày active, còn Seasonal baseline vẫn giữ nguyên bên dưới.

Commit UI mặc định tắt và chỉ mở khi `NEXT_PUBLIC_DAILY_IMPORT_V1_COMMIT_ENABLED=true`. Stage có thể tắt bằng `NEXT_PUBLIC_DAILY_IMPORT_V1_STAGE_ENABLED=false`.

## Luồng và module đã triển khai

- Workbook adapter: `app/src/lib/dailyScheduleWorkbook.ts`.
- Canonical parser/validation: `app/src/lib/dailyScheduleImport.ts`, `app/src/lib/dailyImportV1Contract.ts`.
- Resource policy: `app/src/lib/operationalResourceValues.ts`.
- UI stage/preview/typed confirmation: `app/src/app/daily/page.tsx`, `app/src/app/components/DailyImportPreviewDialog.tsx`.
- Client RPC: `app/src/lib/remoteStore.ts`, `app/src/lib/supabaseStore.ts`, `app/src/lib/dailyImportRpcContract.ts`.
- Stand text migration: `app/supabase/migrations/20260828083000_allow_alphanumeric_stand_values.sql`.
- Staging/atomic commit/effective views: `app/supabase/migrations/20260828090000_daily_schedule_import_v1.sql`.
- Seasonal Full Replace compatibility: `app/supabase/migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql`.

Database objects chính:

- `daily_schedule_import_batches`
- `daily_schedule_import_batch_legs`
- `daily_schedule_import_seasons`
- `daily_schedule_active_days`
- `stage_daily_schedule_import_v1(jsonb)`
- `commit_daily_schedule_import_v1(uuid,jsonb,text)`
- `get_daily_schedule_import_v1_status(uuid)`
- `cancel_daily_schedule_import_v1(uuid)`
- `daily_schedule_effective_records_v1`
- `daily_schedule_effective_record_counters_v1`

## Shadow parse trên hai workbook thật

Lệnh: `npm run shadow:daily-import-v1`. Harness chỉ đọc file và tạo canonical payload trong bộ nhớ; không stage RPC và không ghi workbook.

| File | Profile / top-left | Rows | Legs | Season | Ops Date | Diagnostics |
|---|---|---:|---:|---|---|---|
| `LB_20260823_20260827.xlsx` | `compact-lb`, header B2 | 358 | 596 | S26 | 2026-08-23..2026-08-27 (5 ngày) | 0 |
| `OperationalTurns (16).xls` | `legacy-operationalturns`, header A1 | 4.985 | 8.072 | S26 | 2026-08-01..2026-09-30 (61 ngày) | 0 |

Checksum read-only:

- LB raw SHA-256: `d2b590155c723b771d0e65fe55c0af4fb42c2cb3797d4339194cc70e84c56c69`.
- LB canonical SHA-256: `33a05239d50a153ac081c03ad528001070a767fb005beaebff47401602b01810`.
- OperationalTurns raw SHA-256: `6254b63c9d430485902d7659e8f810dd4dbc8a7ab5dfec6d5950c36db84f09d1`.
- OperationalTurns canonical SHA-256: `afdd5b44d3898b42fe7215bb131fa179e6bfda898f603daf88e05f612109c0dd`.

Resource evidence trong file LB: 63 row có bare `G`, 295 DEP legs có gate prefix `G`, 6 legs có stand alphanumeric, 296 legs có counter `C...`, 8 legs có counter `M...`. Bare `G` không còn tạo DEP side giả và được coi là missing.

## Bằng chứng atomic, stale và Seasonal compatibility

PGlite test `daily_schedule_import_v1_pglite.mjs` xác nhận:

- `Stand20A -> 20A` round-trip qua record và modification PostgreSQL.
- `G1 -> 1`, `C30 M1 -> 30,M1`.
- Preview trả before/after và overlapping Daily import dùng snapshot active hiện tại làm before.
- Coverage gap giữa range start/end bị server chặn bằng `DAILY_COVERAGE_GAP`.
- Commit giữ nguyên Seasonal baseline và chỉ đổi active-day pointer.
- Stable effective record ID giữ Gate overlay hiện có.
- Workspace allocation RPC và reporting view đều đọc Daily active snapshot.
- Seasonal Full Replace mô phỏng vẫn giữ Daily snapshot và overlay gắn với stable Daily identity.
- Fault injection sau bước ghi active pointer làm toàn bộ statement rollback; pointer cũ còn nguyên.
- Multi-season fault injection tại season cuối rollback active pointer, `dataVersion` và audit/realtime event đã thực hiện ở season đầu.
- Stale dataVersion trả SQLSTATE `40001`; active pointer cũ còn nguyên.
- Stage lặp lại cùng `requestId`/checksum trả đúng batch cũ; reuse requestId với payload khác bị chặn; commit lặp lại và status recovery trả durable receipt cũ mà không apply lần hai.
- Commit ghi `season_change_events` cùng checksum/count/dataVersion để realtime và audit/reconciliation dùng chung.
- Effective views dùng RLS + `security_invoker`; operator cần `daily.read`/`seasonal.read`.

## Test đã chạy và pass

- `npm run shadow:daily-import-v1`
- `npm run test:daily-import` — 5/5.
- `npm run test:daily-import-sql` — pass.
- `npm run test:rules` — pass.
- `npm run test:seasonal-import-sql` — pass.
- `npm run test:seasonal-import-v3-sql` — pass.
- `npm run test:seasonal-schema-twice` — schema apply hai lần đều pass.
- `npx tsc --noEmit` — pass.
- Targeted ESLint — 0 errors.
- `cargo test --test native_catchup` — 56/56.
- `npm run build` — pass, gồm route `/daily`, `/gate`, `/checkin`, `/seasonal`.

## Audit production self-hosted Supabase qua SSH trước rollout

Audit ngày 2026-08-28 chỉ chạy lệnh đọc metadata/schema; không tạo dump, clone, migration, import hoặc thay đổi service trên máy chủ.

- Supabase chạy bằng Docker Compose project `opsdata-supabase`; PostgreSQL `17.6`, primary, timezone `UTC`, database `postgres` khoảng `696 MB`.
- Host còn khoảng `348 GB` disk và `8,3 GiB` RAM available; đủ tài nguyên dự kiến cho một clone rehearsal cô lập.
- Production hiện có 4 seasons, 60.963 `season_flight_records`, 3.297 `season_modifications`.
- Bốn cột `stand` production vẫn là `integer`; toàn bộ bảng/RPC Daily V1 chưa tồn tại. Production không có app migration ledger `supabase_migrations.schema_migrations`, vì vậy rollout phải dùng manifest/checksum riêng và postcondition thay vì suy luận từ migration history.
- Hai JSON upsert function có đúng các cast `stand::integer` mà migration cần thay. Dependency cấp cột xác nhận chỉ `reporting.effective_flight_operations` phụ thuộc ba cột stand của Seasonal; không có reporting object khác phụ thuộc trực tiếp các cột này.
- `season_change_events` đã nằm trong publication `supabase_realtime`; Daily commit event có đường realtime hiện hữu để client khác invalidate/reload workspace.
- Production có `reporting.public_traffic_effective` là materialized view 43 MB, 60.357 rows. Nó không phụ thuộc `effective_flight_operations`, mà đọc chuỗi public-traffic views trực tiếp từ bảng Seasonal. Timer refresh đang disabled; service refresh là manual.
- Migration stand ban đầu có `GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO authenticated`, sẽ vô tình mở quyền đọc materialized traffic snapshot đang bị revoke cho `anon`, `authenticated` và `service_role`. Dòng grant rộng đã được bỏ. Migration hiện lưu/khôi phục owner, ACL và index của reporting object; regression fixture materialized-view xác nhận không widening quyền.

Hệ quả: Daily/Gate/Check-in và `reporting.effective_flight_operations` đọc Daily active snapshot đúng thiết kế. Public traffic report hiện vẫn là Seasonal-baseline snapshot và không tự phản ánh Daily import, kể cả khi refresh. Nếu public traffic report cũng phải dùng Daily effective schedule, cần một thay đổi riêng ở pipeline `public_traffic_candidates` + recency/watermark + refresh operation; chưa được tự ý gộp vào lần sửa này.

Migration manifest SHA-256 dùng cho clone/release gate:

- `20260828083000_allow_alphanumeric_stand_values.sql`: `7300177F1DD6D31CF63ADA28947211094B626110A8E7BEBF613DAEA8AEC47F89`
- `20260828090000_daily_schedule_import_v1.sql`: `B7772C4A7159F2C59A0F550C7ABBDE23DF23350500BDFA6A27AB8B7F28AEF1AE`
- `20260828100000_preserve_daily_overlays_during_seasonal_replace.sql`: `F2A54FC78AE9F80B59BC85384B64E00E796E0F453870E70890CEF0B2F09847FC`

## Production rollout file LB ngày 2026-08-29

Rollout được thực hiện bằng actor ứng dụng `tuanlm` (`6b289716-136f-491a-83de-d1c9983ca3da`) sau các gate sau:

1. Full custom-format dump có owner/ACL được tạo trước migration:
   - Path: `/home/ops/seasonal-backups/daily-import-v1-20260829T042500Z/pre-daily-import-production.dump`
   - Size: `47.360.280` bytes; 1.306 TOC entries.
   - SHA-256: `644671b18ca4bdc2d098d04c4e8468092c41163de2c622e72d68be63567aefcd`.
2. Dump được restore sạch vào container `supabase/postgres:17.6.1.136`, `--network none`, không expose port. Ba migration apply thành công trên clone; 60.963 baseline records giữ nguyên, bốn stand columns thành text, RPC Daily tồn tại và traffic materialized view giữ đủ 6 index.
3. Exact LB payload được stage/commit trên clone: before 669, after 596, matched 590, inserted 6, preserved allocation 45; season version tăng đúng một lần và audit receipt hợp lệ.
4. Ba migration được apply production trong cùng một `psql --single-transaction`, với `lock_timeout=15s`. Postcondition trước import: baseline 60.963, S26 `dataVersion=16573`, Daily batches 0, traffic snapshot 60.357 rows/6 index và ACL vẫn khóa.

Production stage có kết quả:

- Request ID: `a1633085-3e0b-5452-b550-c1f35421925a`.
- Raw checksum: `d2b590155c723b771d0e65fe55c0af4fb42c2cb3797d4339194cc70e84c56c69`.
- Production canonical checksum: `167c6808b62f6761ada643b1d659cd5112f823b51f428e7bac343d8317efb300` (bao gồm production season ID/version nên khác shadow checksum).
- Preview hash: `897ed357c6237754d477cdd264ca99820e3617627f3d03f1aae41687980488b9`.
- 358 source rows, 596 legs, S26, Ops Date `2026-08-23..2026-08-27`.
- Before 669, after 596, matched 590, inserted 6, preserved allocation 45, diagnostics 0.

Production commit receipt:

- Batch ID: `0b4ba05e-d42a-485d-a97e-366b8b5bef43`.
- Status: `committed`; S26 `dataVersion=16574`; server high-water `47545`.
- Effective Daily counts: 124 / 119 / 112 / 116 / 125 theo ngày 23–27/08, tổng 596.
- Baseline `season_flight_records` vẫn 60.963; active-day pointers 5; batch legs 596.
- Workspace RPC trả 596 flight records, 45 modifications, 1.208 counter rows và snapshot `{dataVersion: 16574, serverHighWater: 47545}`.
- Reporting effective trả 594 rows: thấp hơn Daily 2 rows vì hai deleted overlays hiện hữu tiếp tục được tôn trọng.
- Resource postconditions: 6 stand `20A`; 295 Gate `G<number>` thành integer; 296 counter `C...` bỏ prefix; 8 token `M...` giữ nguyên; bare `G` trên hai DEP legs được lưu `gate=null`.
- Audit event `dailyImport` có đúng actor, raw checksum, before 669, after 596 và `server_seq=47545`; `season_change_events` vẫn thuộc publication `supabase_realtime`.
- Database health sau commit: không có idle transaction; database khoảng 651 MB; Daily batch-leg relation khoảng 912 kB.
- Public traffic materialized snapshot vẫn 60.357 rows, watermark 46044 và không được refresh/chuyển sang Daily effective source trong rollout này.

## Phần còn lại sau production import

Database commit và server-side reconciliation đã pass. Các acceptance còn lại:

1. Chạy E2E hai client đã đăng nhập để xác nhận realtime invalidation và UI revalidate vật lý; database event/publication đã có nhưng chưa thay thế acceptance trên thiết bị thật.
2. Deploy client build/feature flags nếu muốn operator sử dụng UI stage/preview/commit mới thay vì controlled server-side import.
3. Chốt nghiệp vụ public traffic report: giữ Seasonal baseline như hiện tại hay chuyển sang Daily effective snapshot; nếu chuyển thì implement/test/refresh theo scope riêng.
4. Thực hiện một Seasonal rebuild có kiểm soát trên clone/canary sau import nếu cần production-level acceptance bổ sung ngoài regression trigger/PGlite hiện có.

Hai workbook người dùng không được copy vào repo; chỉ hash/count được lưu trong artifact này.

### Trạng thái môi trường rehearsal

Rehearsal PostgreSQL 17 trên server và exact-payload clone import đã hoàn tất trước production. Full dump, manifest, migration logs, clone logs, stage/commit results và postconditions được giữ trong `/home/ops/seasonal-backups/daily-import-v1-20260829T042500Z`. Clone dùng tmpfs/network-none có thể xóa sau khi kết thúc acceptance vì có thể dựng lại từ dump đã lưu.
