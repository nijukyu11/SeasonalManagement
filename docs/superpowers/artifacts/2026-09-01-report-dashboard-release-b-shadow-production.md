# Production receipt — Report/Dashboard Release B fail-closed shadow

**Thời điểm:** 2026-09-01 11:18–11:29 GMT+7

**Phạm vi:** sửa quality seam của Daily Publisher, clone rehearsal, tạo một production shadow attempt; giữ Dashboard/Report UI đọc v1, không ghi coverage certification, không refresh/disable materialized view.

**Source branch:** `codex/live-traffic-aggregate-integration`

## Phát hiện trước publish

Publisher gọi live v2 với scope `timeline`, nhưng lại lấy `report.coverage`, trường chỉ tồn tại trong scope `full`. `NULL` bị `coalesce` thành `0`, nên attempt có thể bỏ qua coverage gate.

Không thể thay bằng `timeline.status`: status này gộp source coverage và Pax missing. Làm vậy sẽ khiến ngưỡng Pax 99,5% trở nên vô nghĩa vì chỉ một missing Pax leg cũng làm ngày thành `partial`.

Interface được làm rõ:

- live v2 timeline thêm `completeness = coverage_status`;
- `status` vẫn giữ semantics dùng cho UI;
- publisher đếm missing/partial từ `completeness`, rồi kiểm tra Pax coverage riêng.

Corrective migration:

- `app/supabase/migrations/20260901113000_public_dashboard_publication_timeline_quality.sql`
- SHA-256: `4259e0b6ab3e83b3a24100bd6cdef62893ea87812b98bbd47d068d60e22ab801`

## Local và clone gates

- `npm run test:traffic-report-contract`: pass.
- PGlite chứng minh coverage `partial` tạo attempt `incomplete` và giữ last-known-good head.
- Production-derived clone dùng PostgreSQL 17.6, network `none`, full custom dump và restore vào database `rehearsal` bằng `supabase_admin --no-owner --exit-on-error`.
- Hai lần thử restore trước final clone dừng trước hotfix/publisher do role/schema scope của image; production không bị chạm. Final clean clone dùng đúng role set đã chứng minh ở Release A.

Final clone receipts:

```json
{"check":"clone_patch","timeline_completeness":true,"publisher_completeness":true}
{"check":"clone_after_incomplete","attempts":1,"heads":0}
{"status":"ready","business_date":"2026-08-30","row_count":29340,"due_legs":29340,"reported_legs":29308,"source_watermark":49954}
{"check":"clone_after_ready","attempts":2,"heads":1,"head_id":2}
```

Ready path chỉ được rehearsal sau khi thêm coverage `complete` **trên clone**. Row này không tồn tại trên production và clone đã được dừng/xóa.

## Backup và production migration

- Run id: `20260901T041809Z-dashboard-release-b-shadow`.
- Rollout: `/home/ops/seasonal-rollouts/20260901T041809Z-dashboard-release-b-shadow`.
- Backup: `/home/ops/seasonal-backups/20260901T041809Z-dashboard-release-b-shadow`.
- Backup gồm full custom dump 64,2 MB, publisher definition trước migration và SHA-256 manifest.
- Preflight: watermark `49954`, coverage/publication/head `0/0/0`.
- Migration apply bằng `psql --single-transaction`; postcondition:

```json
{"watermark":49954,"coverage_rows":0,"publication_rows":0,"head_rows":0,"timeline_completeness":true,"publisher_completeness":true,"anon_publisher":false,"service_publisher":true}
```

Không refresh MV, không đổi static symlink, feature flag hoặc Edge route.

## Production shadow attempt

Business Date được chọn là 30/08/2026 vì mọi leg đã mature tại semantic as-of:

- flights/due legs: `29340/29340`;
- reported legs: `29308`;
- Pax coverage: `99,89%`;
- source watermark: `49954`.

Production coverage ledger đang rỗng, nên 242 ngày YTD có flight đều mang `completeness=partial`. Shadow receipt:

```json
{"publication_id":1,"status":"incomplete","business_date":"2026-08-30","row_count":29340,"due_legs":29340,"reported_legs":29308,"source_watermark":49954}
```

Retry cùng idempotency key trả lại publication id `1`; ledger vẫn đúng một row. Head không được tạo.

Đối chiếu payload attempt với live v2 pin cùng watermark/data-as-of:

```json
{"payload_reported_pax":5157402,"metric_reported_pax":5157402,"payload_arrival_pax":2548214,"metric_arrival_pax":2548214,"payload_departure_pax":2609188,"metric_departure_pax":2609188,"checksum_valid":true}
```

## Public smoke và current state

- `/api/report/v1/dashboard-publication?year=2026`: HTTP 503, `Cache-Control: no-store`.
- `/api/report/v1/dashboard-publication-version?year=2026`: HTTP 200, `freshness=missing`, `latest_attempt_status=incomplete`, publication id `null`.
- `/api/report/v1/annual-kpi?year=2026`: HTTP 200.
- Public Report và Dashboard HTML: HTTP 200.
- Dashboard UI vẫn đọc annual KPI v1; Report UI vẫn đọc report v1.

## Kết luận và next gate

Release B fail-closed shadow đã chứng minh publisher không thể tạo ready publication khi thiếu coverage acceptance. Metric payload và canonical live v2 đồng bộ tuyệt đối ở cùng semantic version.

Chưa được phép tự suy ra `complete` chỉ vì có `dailyImport` event. Bước tiếp theo phải chốt authority và receipt cho coverage acceptance, rồi implement một hook/command server-side ghi `public_traffic_coverage` từ acceptance đã xác thực. Sau đó mới chạy ready shadow cho nhiều Business Date và xem xét Dashboard cutover riêng.
