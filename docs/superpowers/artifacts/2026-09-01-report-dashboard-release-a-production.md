# Production receipt — Report/Dashboard Release A

**Thời điểm:** 2026-09-01 10:54–11:01 GMT+7

**Phạm vi được duyệt:** backend additive + Edge; giữ feature flags tắt, không cutover UI, không tạo Daily Publication, không refresh/disable MV.

**Source branch:** `codex/live-traffic-aggregate-integration`

**Implementation commit trước release:** `1dbdf98`

## Backup và rollback evidence

- Run id: `20260901T035421Z`.
- Rollout: `/home/ops/seasonal-rollouts/20260901T035421Z-report-release-a`.
- Backup: `/home/ops/seasonal-backups/20260901T035421Z-report-release-a`.
- Có full custom dump, schema dump, Edge source trước release, root-only Edge env backup và SHA-256 manifest.
- Preflight: watermark `49954`, projection `fresh|49954`; v2 function và publication ledger chưa tồn tại.

## Database additive release

Ba migration được apply bằng một `psql --single-transaction`:

1. bounded canonical candidate seam;
2. live aggregate v2 với fixed semantic `data_as_of`;
3. immutable Daily Publication ledger/publisher/read wrappers.

Postconditions:

```json
{"live_v2":true,"projection":"fresh|49954","candidate_slice":true,"source_watermark":49954,"publication_ledger":true,"publication_head_rows":0}
```

Service-role database smoke cho tháng 8:

```json
{"flights":3937,"reported_pax":685084,"missing_due_legs":16,"source_watermark":49954,"source_mode":"live","contract_version":"traffic-report-v2"}
```

ACL:

```json
{"anon_publisher":false,"service_publisher":true,"service_direct_ledger":false,"service_candidate_slice":false}
```

Không refresh MV; projection và watermark không đổi.

## Edge release

- Read-version secret được tạo trên host và lưu root-only; receipt chỉ ghi nhận key tồn tại, không lưu giá trị.
- Final Edge source SHA-256: `75df14ce1a155688c98ab082e102e300c53ac94d24b10ebd058325e8cb86f6f4`.
- Container: `opsdata-traffic-report-edge`, state `running`, restart count `0` sau recreate cuối.
- Static symlink không đổi: `/srv/seasonal-traffic-report/releases/20260831T122517Z-kpi-cache-fix-production`.

Trong smoke đầu, origin v2 đúng nhưng public `/api/report/v2` trả v1 từ route cũ. Nguyên nhân: Nginx map request thành `/traffic-report/v2`, trong khi Edge chỉ nhận diện `/api/report/v2`. Edge Interface được sửa nhận cả hai deployed path; không cần đổi Nginx.

Final read-version smoke:

```json
{"contract":"traffic-report-v2","watermark":49954,"token_present":true,"etag_present":true,"initial_cache":"EXPIRED","conditional_status":304,"missing_token_status":409,"missing_token_code":"READ_VERSION_CHANGED","wrong_watermark_status":409,"wrong_watermark_code":"READ_VERSION_CHANGED"}
```

Cache public v2 kiểm tra riêng: request đầu `MISS`, request sau `HIT`, cùng ETag và `X-Report-Source-Mode: live`.

Dashboard publication state đúng với Release A:

- payload endpoint: HTTP 503 `DASHBOARD_PUBLICATION_NOT_READY`, `no-store`;
- version endpoint: HTTP 200, `freshness=missing`, publication id `null`;
- ledger rows `0`, head rows `0`.

## V1/V2 semantic reconciliation

Public range 02–30/08 có cùng flights `3685` và watermark `49954`, nhưng v1 Pax `651761` so với live v2 Pax `659992`. Direct SQL chứng minh đây không phải nguồn canonical khác nhau:

- v1 tại projection `refreshed_at=2026-08-31T11:23:48.479984Z`: Pax `651761`, due legs `3638`;
- v2 pin cùng `data_as_of`: Pax `651761`, due legs `3638`;
- v2 live tại thời điểm release: Pax `659992`, due legs `3685`.

Chênh lệch là Pax T+1 mature sau projection time, đúng lý do Report Read Version phải pin semantic `data_as_of`. UI production vẫn đọc v1 vì static artifact/feature flags không đổi.

## Final production state

- source watermark: `49954`;
- projection: `fresh|49954`;
- publication ledger/head: `0/0`;
- public Report và Dashboard HTML: HTTP 200;
- v1 contract vẫn `traffic-report-v1`;
- v2 contract public đã sẵn sàng nhưng chưa có UI consumer.

## Next approval boundary

Release B mới được phép tạo shadow Daily Publication. Chỉ publish một Business Date sau khi `due_legs = flights`, giữ Dashboard UI đọc v1 và đối chiếu payload/receipt trước mọi cutover.
