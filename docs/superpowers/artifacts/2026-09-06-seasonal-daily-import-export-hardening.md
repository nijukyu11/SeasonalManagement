# P1/P2 import/export hardening — kết quả cục bộ

Ngày: 2026-09-06. Theo audit `2026-09-05-seasonal-daily-import-export-audit.md` và yêu cầu sửa toàn bộ P1/P2.

## Phạm vi và trạng thái

- Đã sửa F01–F09 trong source và migration cục bộ; bổ sung regression tests.
- Chưa chạy migration, import, reset hoặc ghi dữ liệu production. Chưa commit/push, bump version hoặc release.
- Giữ nguyên các thay đổi có sẵn của người dùng ở Dashboard/Report, tài liệu và AGENTS.md.
- Quyết định F07 đã được người dùng xác nhận: **chặn cùng airline + số hiệu chuyến trong cùng ngày lịch**, kể cả khác side, giờ, route hoặc nằm hai phía cutoff Ops Date. Chuyến đã bị loại bởi rule cancellation không nằm trong tập chuyến cần kiểm tra duplicate.

## Mapping thay đổi

| Finding | Thay đổi | Kiểm chứng |
| --- | --- | --- |
| F01 | Resolver terminal leaf dùng chung cho Seasonal/Daily/Undo, nhận Seasonal có batch; giữ provenance successor và chặn lịch sử superseded. Daily fingerprint base/overlay/counter/window tại stage, kiểm tra lại trước write. | SQL: Seasonal Replace → Merge → Replace vẫn deleted; Undo row cũ bị chặn, Undo row hiện hành hợp lệ; Seasonal có batch → Daily → Daily vẫn deleted; thay gate giữa stage/commit bị PT409 và rollback. |
| F02 | Coverage lấy độc lập từ ngày của nguồn, trước lọc CX/Cancelled. Giữ boundary dates; all-cancelled có thể stage tập rỗng sau xác nhận rõ ngày. Confirmation không được thu hẹp range, chọn ngày lỗi hoặc ngoài preview. | Fixture cho cả hai profile, đầu/cuối, all-cancelled, cutoff 05:00, invalid date; SQL empty replacement có explicit zero dates. |
| F03 | Mọi Seasonal insert, gồm Merge trong Daily scope, dùng ID generation theo batch; terminal rebase không bị tính nhầm thành active baseline match; audit lưu cả predecessor/successor. | Merge lặp 3 lần không trùng ID, Daily active row giữ nguyên. |
| F04 | `get_seasonal_export_snapshot_v2` chỉ trả canonical-active, không deleted overlay; mọi child relation cùng filter theo tập export records. Legacy added children không còn là nguồn export sau cutover. | SQL gọi với role authenticated: historical manual-added và counters bị loại, active manual/stand được giữ, count khớp arrays; stale version PT409. |
| F05 | Validator overlay stand chấp nhận text, legacy integer hoặc null như base row. | `20A`, `20`, integer 20 và null pass; object bị từ chối. |
| F06 | Daily dùng chung `cleanFlightNumber` với Seasonal; TS và SQL pad phần số trước suffix: `VN1A` → `VN001A`. Matching SQL normalize cả bản cũ thay vì so sánh nguyên văn. | Fixture TS gồm numeric suffix, leading zero và airline `7C`; SQL normalization parity; round-trip/rules pass. |
| F07 | Daily parser và stage RPC chặn flight number lặp theo calendar date; Seasonal giữ policy tương ứng. Không lặng lẽ dedupe bằng cách bỏ chuyến. | Cùng số hiệu khác giờ/route bị chặn; hai phía cutoff vẫn bị chặn nếu cùng calendar date; ngày khác được giữ. SQL Seasonal và Daily đều có case duplicate. |
| F08 | Receipt committed được giữ trong session trước await refresh; lỗi read có trạng thái riêng và nút retry chỉ đọc, không commit lại. Retry không hạ data version đã mới hơn. | Fault-injection unit test refresh fail → giữ receipt → retry thành công; source contract khóa đường retry và persistence. |
| F09 | Preview tách chuyến/Pax trong file và effective sau overlay; không fallback số raw thay cho effective; Pax unknown không hiển thị thành zero. | Test effective count khác raw, Pax known zero, Pax null/unknown và thiếu effective metadata. |

Preview giữ nhãn nghiệp vụ, số liệu dạng tabular và dùng native modal alert dialog để trình duyệt quản lý focus/bàn phím. Không khôi phục typed `REPLACE ...`; zero-flight scope vẫn có xác nhận riêng.

## Các gap liên quan đã xử lý

- G01: thêm alias và nhận tiêu đề identity thay đổi khi còn đủ anchor khác + dữ liệu tại đúng vị trí. Header bị swap hoặc profile không xác định vẫn bị chặn. Không cam kết nhận mọi sheet có toàn bộ tiêu đề tùy ý: tránh đoán profile sai rồi áp sai rule cancellation.
- G02: Seasonal stage/commit/export business stale conflicts dùng PT409; Undo stale cũng dùng PT409. Chưa chạy HTTP concurrency test qua gateway production.
- G03: đưa hotfix `20260904183000_daily_import_stage_indexed_ops_date.sql` về source hiện tại; nhận biết hotfix đã có để có thể áp lại an toàn nếu ledger chưa ghi nhận. Có test áp hotfix hai lần.
- G04: sửa source-test path `(desktop)`, bỏ tạo trùng role trong fixture và cập nhật runbook bỏ typed confirmation Daily.

## Migration và rollout cần làm sau phê duyệt

Thứ tự:

1. `app/supabase/migrations/20260904183000_daily_import_stage_indexed_ops_date.sql` — hotfix đã được quan sát trên production trong audit; kiểm tra ledger trước rollout.
2. `app/supabase/migrations/20260906010000_import_terminal_coverage_and_identity.sql` — normalization, terminal/Undo, source fingerprint, zero-flight, duplicate policy, preview guard và PT409. Có thêm partial index `(season_id, supersedes_record_id)` phục vụ kiểm tra lineage, không đổi các cột nghiệp vụ và không backfill flight data.
3. `app/supabase/migrations/20260906011000_active_seasonal_export_snapshot.sql` — active snapshot cùng các child relations.

Triển khai SQL trước app cùng đợt release, vì normalization và duplicate policy phải nhất quán. Preview chưa commit tạo trước contract mới bị chặn và cần stage lại. Receipt của batch đã committed vẫn idempotent, không được import lại chỉ vì refresh lỗi.

Trước production: rehearsal PostgreSQL clone, backup định nghĩa RPC và kiểm tra migration ledger/index build lock; kiểm tra stage/commit stale qua HTTP có timeout hữu hạn; đối chiếu active count/Pax/report cùng watermark sau import thử đã được duyệt. Không chỉ rollback một phía parser hoặc SQL normalization khi phía kia vẫn chạy bản mới.

Không sửa canonical data hay lịch sử có sẵn trong migration này. Việc data repair nếu phát hiện flight từng sống lại hoặc boundary date từng bị bỏ sót cần audit và phê duyệt riêng.

## Verification cục bộ

Đã chạy:

- `npm run test:daily-import`: 30/30.
- `npm run test:atomic-flight`: 6/6.
- Exporter + snapshot + selection + Seasonal V3 contract + recovery: 50/50.
- `node --test src/lib/canonicalSeasonalRows.raw-flight.test.cjs`: 8/8.
- `npm run test:daily-canonical-commit`: pass, bao gồm failpoint rollback/idempotency/multi-season và regression mới.
- `npm run test:seasonal-canonical-authority`: pass, bao gồm repeated Merge, terminal/Undo và authenticated active export.
- `npm run test:seasonal-import-v3-sql`: pass; lỗi role bootstrap trước đây đã được giải quyết.
- `npm run test:rules`: pass.
- TypeScript `tsc --noEmit`, lint các file implementation sửa và `npm run build`: pass.

Cache route `.next/dev/types` cũ chứa đường dẫn trước `(desktop)` gây lỗi typecheck ban đầu. Đã sinh lại production route types và chuyển riêng cache dev lỗi sang bản sao có thể khôi phục:

`C:/Users/tuan/AppData/Local/Temp/seasonal-stale-next-types-41137fb7-c0d0-46dd-a330-f26e137b4198`

Không sửa source/tsconfig để bỏ qua lỗi TypeScript. Chưa nghiệm thu giao diện Tauri bằng thao tác thực tế, chưa import các workbook thật vào production trong đợt sửa này. PGlite và unit tests không thay thế PostgreSQL/gateway/desktop acceptance.
