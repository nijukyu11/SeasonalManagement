# Biên bản triển khai local — Live Traffic Aggregate cho Report và Dashboard

**Ngày:** 2026-08-31

**Nhánh:** `codex/live-traffic-aggregate-integration`

**Trạng thái:** Đã implement additive tại local và rehearsal clone; **chưa deploy, chưa migration production, chưa bật UI v2**.

## 1. Kết luận cổng hiện tại

- Hai nhánh Daily/canonical và Report đã được commit riêng rồi merge bằng merge commit vào một integration worktree sạch.
- `traffic-report-v2` đã có contract, live aggregate RPC, Edge API v2, shared adapter và Dashboard Report Mode.
- Dashboard Report Mode mặc định bị khóa bằng `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED`; không có giá trị `1` thì Dashboard tiếp tục chỉ hiện các mode hiện hành.
- V2 chỉ đọc `reporting.public_traffic_candidates`; view production này đã được kiểm tra read-only và đang đọc `reporting.canonical_effective_flight_legs`, không đọc raw history.
- PGlite đã chứng minh v1 snapshot và v2 live khớp KPI, daily và route tại cùng watermark cho fixture canonical; Pax NULL, true zero, future và missing day được phân biệt.
- Cổng performance **chưa đạt để production cutover**. Không bật Report/Dashboard v2 và không decommission snapshot v1 ở trạng thái hiện tại.

## 2. Cấu trúc đích đã triển khai

```mermaid
flowchart LR
  I[Seasonal / Daily / Manual commit] --> C[Canonical active records]
  C --> E[canonical_effective_flight_legs]
  E --> P[public_traffic_candidates<br/>dedupe + quarantine]
  P --> L[get_public_traffic_report_v2<br/>one-statement live aggregate]
  L --> A[/api/report/v2<br/>ETag + watermark + 409]
  A --> S[Shared trafficReportDataAdapter]
  S --> R[Report v2<br/>chưa cutover]
  S --> D[Dashboard Report Mode<br/>feature-gated]

  P --> M[public_traffic_effective MV]
  M --> V1[/api/report/v1<br/>rollback hiện hành]

  W[Workspace RPC v2] --> O[Dashboard Operational Mode]

  classDef gated fill:#fff7ed,stroke:#c2410c,color:#7c2d12;
  classDef live fill:#ecfdf5,stroke:#047857,color:#064e3b;
  class R,D gated;
  class L,A,S live;
```

Nguyên tắc đồng bộ:

```text
cùng normalized filter
  + cùng contractVersion
  + cùng sourceWatermark
  + cùng filterHash
  = mới được coi là cùng phiên bản dữ liệu
```

Request phụ pin `expected_watermark`. Nếu dữ liệu đổi, API trả `409 DATA_VERSION_CHANGED`; adapter bỏ bundle cũ và tải lại toàn bộ, không merge dữ liệu của hai watermark.

## 3. Những gì đã thay đổi

| Lớp | Thay đổi | Trạng thái |
|---|---|---|
| Git | Merge Daily/canonical trước, Report sau vào integration branch | Hoàn tất |
| Contract | `trafficReportV2Contract.ts` với version envelope và strict decoder | Hoàn tất local |
| SQL | `get_public_traffic_report_v2(...)`, aggregate-only, SECURITY DEFINER | Hoàn tất local + clone |
| API | `/api/report/v2/{overview,timeline,dimension,export}` | Hoàn tất local |
| Version | ETag theo watermark/filter; 409 khi expected watermark lệch | Hoàn tất local |
| Pax | NULL khác 0; future/not-due không nhập vào reported Pax | Đã test |
| Empty day | Uncovered missing day trả `null/—`; certified zero day trả `0` | Đã test |
| Shared client | Adapter dùng chung, bỏ credentials, validate payload, full reload khi 409 | Hoàn tất local |
| Dashboard | Report Mode dùng shared adapter, không gọi `buildDashboardOverview` | Hoàn tất, mặc định tắt |
| Report | V1 vẫn là UI mặc định; chưa chuyển vì v2 chưa đủ performance/feature parity | Chưa cutover |
| Snapshot v1 | MV/timer giữ nguyên làm rollback | Không thay đổi |

## 4. Bằng chứng dữ liệu và quyền truy cập

Kiểm tra read-only production trước rehearsal:

- `reporting.public_traffic_candidates` đọc canonical effective boundary, không đọc raw table trực tiếp.
- 67.172 candidate rows, Ops Date từ 2025-10-25 đến 2027-03-28.
- Watermark tại thời điểm clone: 49.954.
- `get_public_traffic_report_v2` chưa tồn tại ở production.

Rehearsal clone:

- Tạo database riêng `live_v2_rehearsal_20260831` trong container clone cô lập, không publish port và không ghi đè database rehearsal cũ.
- Restore từ `pg_dump` production theo đường đọc; kích thước restore 787 MB, 67.172 candidates, watermark 49.954.
- Apply migration v2 hai lần thành công để kiểm tra idempotency.
- ACL sau migration: chỉ `service_role` có EXECUTE public wrapper; `service_role`, `anon`, `authenticated` không có SELECT trên candidate view.
- Không có schema/data/migration production nào được thay đổi.

## 5. Performance receipt

Warm execution của full RPC trên clone production-compatible, comparison=`none`:

| Range | Execution time | Buffers/temp đáng chú ý |
|---|---:|---|
| 7 ngày | 526 ms | 8.131 hit, 3.717 read |
| 30 ngày | 615 ms | 20.158 hit, 3.653 read |
| YTD | 1.513 ms | temp read 3.305 / written 4.594 |
| Full range | 2.830 ms | temp read 7.553 / written 9.912 |

Một expression index Ops Date đã được thử **chỉ trên clone**. Planner chọn plan xấu hơn và query vượt thời gian quan sát; index đã được xóa, `ANALYZE` lại, không đưa vào migration và không tồn tại ở production.

`EXPLAIN (ANALYZE, BUFFERS)` cho candidate slice 7 ngày xác định bottleneck cụ thể:

- riêng `count(*)` trên `public_traffic_candidates` mất khoảng 196 ms;
- planner vẫn parallel-sequential-scan canonical base và loại khoảng 22 nghìn row mỗi worker;
- nguyên nhân là Ops Date hiệu lực có thể phụ thuộc `season_modifications.schedule`, nên predicate chứa `CASE` sau join và không thể dùng an toàn index Ops Date chỉ đặt trên base record;
- entity/season recency CTE không phải bottleneck chính trong mẫu này.

Đánh giá:

- 7/30 ngày có thể dùng với cache ngắn nhưng chưa có bằng chứng p95/concurrency/import-load.
- YTD/full range còn temp spill và chưa đạt budget an toàn cho public cutover.
- `statement_timeout` trong function không thay thế timeout/cancellation ở gateway; cần kiểm tra lại enforcement ở PostgREST/Edge.
- Hướng tối ưu tiếp theo phải materialize/index **effective Ops Date tại canonical write boundary** hoặc tách rõ nhánh schedule không sửa/schedule đã sửa trong một canonical slice function. Không thêm index base đơn lẻ vì clone đã chứng minh cách đó có thể làm plan xấu hơn.

## 6. Validation đã đạt

- Contract unit tests: URL normalize, strict decoder, version envelope, NULL/0/future/missing.
- Adapter unit tests: không gửi credentials, decode aggregate, 409 full reload, retryability.
- PGlite: migration v2 apply hai lần; A/D/all; Pax NULL và true zero; expected watermark mismatch; aggregate-only ACL.
- Differential PGlite tại cùng watermark: KPI current, daily timeline và route dimensions của v1/v2 khớp.
- Dashboard source gate: Report Mode chỉ dùng shared adapter, không dùng row-level `FlightRecord` hoặc `buildDashboardOverview`.
- TypeScript và targeted lint đạt sau thay đổi.

## 7. Cổng còn lại trước production

1. Tối ưu live query theo plan thực tế; không thêm index vào production khi clone chưa chứng minh.
2. Chạy benchmark cold/warm và concurrency 1/10/50, có import đồng thời; chốt budget p50/p95/p99.
3. Bổ sung v2 feature parity cho Report hiện hành: peak hour, day-of-week, aircraft group/type, recurring flights và Excel/CSV cùng watermark.
4. Deploy API v2 vào staging, giữ UI v1; chạy real v1/v2 differential matrix trên cùng watermark.
5. Browser UAT Report và Dashboard Report Mode trên desktop/mobile, xác nhận `—` và `0` đúng.
6. Chỉ sau các gate trên mới xin duyệt production dual-run/cutover.
7. Decommission snapshot/MV/timer là release riêng sau soak window; không nằm trong cutover đầu.

## 8. Quyết định rollback

- Hiện tại: không set feature flag, v1 tiếp tục phục vụ.
- Nếu staging v2 lỗi: remove/disable route v2; không cần rollback dữ liệu vì v2 chỉ đọc.
- Nếu UI v2 đã bật sau này: tắt release flag và quay về v1; giữ nguyên MV/timer trong toàn bộ soak window.
