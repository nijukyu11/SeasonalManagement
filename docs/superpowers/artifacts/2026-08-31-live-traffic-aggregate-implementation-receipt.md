# Biên bản triển khai local — Live Traffic Aggregate cho Report và Dashboard

**Ngày:** 2026-09-01

**Nhánh:** `codex/live-traffic-aggregate-integration`

**Trạng thái:** Đã implement additive tại local và rehearsal clone; **chưa deploy, chưa migration production, chưa bật UI v2**.

## 1. Kết luận cổng hiện tại

- Hai nhánh Daily/canonical và Report đã được commit riêng rồi merge bằng merge commit vào một integration worktree sạch.
- `traffic-report-v2` đã có contract, live aggregate RPC, Edge API v2, shared adapter, Report và Dashboard Report Mode.
- Cả Report và Dashboard Report Mode cùng bị khóa bằng `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED`; không có giá trị `1` thì Report tiếp tục dùng v1 và Dashboard tiếp tục chỉ hiện các mode hiện hành.
- V2 đọc qua internal Interface `reporting.get_public_traffic_candidate_slice_v1(from,to)`. Interface này chỉ chọn canonical active rows, áp `season_modifications`, Ops Date và authoritative recency; không đọc Daily staging hoặc raw deleted/history rows.
- Candidate slice đã khớp `reporting.public_traffic_candidates` trên đủ 67.172 row/20 cột của clone, chia theo 18 tháng, sai khác hai chiều bằng 0.
- PGlite đã chứng minh v1 snapshot và v2 live khớp KPI, daily và route tại cùng watermark cho fixture canonical; Pax NULL, true zero, future và missing day được phân biệt.
- Feature parity và differential clone đã đạt. Concurrency 8-way đạt, nhưng payload đầy đủ YTD/full-range còn chậm; staging latency budget, browser UAT và production dual-run chưa đạt. Vì vậy chưa bật UI v2 và chưa decommission snapshot v1.

## 2. Cấu trúc đích đã triển khai

```mermaid
flowchart LR
  I[Seasonal / Daily / Manual commit] --> C[Canonical active records]
  C --> B[get_public_traffic_canonical_bounds_v1<br/>internal bounds]
  C --> Q[get_public_traffic_candidate_slice_v1<br/>active + overlay + Ops Date + recency]
  E[canonical_effective_flight_legs] --> P[public_traffic_candidates<br/>equivalence oracle / snapshot source]
  C --> E
  Q --> L[get_public_traffic_report_v2<br/>dedupe + quarantine + one statement]
  L --> A[/api/report/v2<br/>ETag + watermark + 409]
  A --> S[Shared trafficReportDataAdapter]
  S --> R[Report v2<br/>feature-gated]
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
| SQL | Internal bounded canonical candidate Interface + `get_public_traffic_report_v2(...)` aggregate-only | Hoàn tất local + clone |
| API | `/api/report/v2/{overview,timeline,dimension,dimension-export,export}` | Hoàn tất local |
| Version | ETag theo watermark/filter; 409 khi expected watermark lệch | Hoàn tất local |
| Pax | NULL khác 0; future/not-due không nhập vào reported Pax | Đã test |
| Empty day | Uncovered missing day trả `null/—`; certified zero day trả `0` | Đã test |
| Shared client | Adapter dùng chung, bỏ credentials, validate payload, full reload khi 409 | Hoàn tất local |
| Dashboard | Report Mode dùng shared adapter, không gọi `buildDashboardOverview` | Hoàn tất, mặc định tắt |
| Report | Dùng shared adapter cho overview/timeline/dimension/CSV/Excel khi bật flag; mọi request phụ pin watermark | Hoàn tất local, mặc định v1 |
| Snapshot v1 | MV/timer giữ nguyên làm rollback | Không thay đổi |

## 4. Bằng chứng dữ liệu và quyền truy cập

Kiểm tra read-only production trước rehearsal:

- `reporting.public_traffic_candidates` đọc canonical effective boundary, không đọc raw table trực tiếp.
- 67.172 candidate rows, Ops Date từ 2025-10-25 đến 2027-03-28.
- Watermark tại thời điểm clone: 49.954.
- `get_public_traffic_report_v2` chưa tồn tại ở production.
- Kiểm tra lại sau rehearsal: production vẫn không có RPC v2 và watermark vẫn 49.954; không migration/refresh production nào được thực hiện.

Rehearsal clone:

- Tạo database riêng `live_v2_rehearsal_20260831` trong container clone cô lập, không publish port và không ghi đè database rehearsal cũ.
- Restore từ `pg_dump` production theo đường đọc; kích thước restore 787 MB, 67.172 candidates, watermark 49.954.
- Apply migration v2 hai lần thành công để kiểm tra idempotency.
- ACL sau migration: chỉ `service_role` có EXECUTE public wrapper; `service_role`, `anon`, `authenticated` không có SELECT trên candidate view.
- Không có schema/data/migration production nào được thay đổi.

## 5. Performance và equivalence receipt

Baseline trước tối ưu, warm execution của full RPC trên clone production-compatible, comparison=`none`:

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

Candidate-slice Interface đã chọn nhánh recency theo cardinality: dưới 10.000 candidate chỉ tra event của leg được chọn; từ 10.000 trở lên aggregate event một lần. Warm execution sau tối ưu:

| Range | Sau tối ưu | Baseline | Kết quả |
|---|---:|---:|---|
| 7 ngày | 90–110 ms | 526 ms | 837 chuyến, giữ nguyên |
| 30 ngày | 182 ms | 615 ms | 3.817 chuyến, giữ nguyên |
| YTD | 930 ms | 1.513 ms | 29.340 chuyến, giữ nguyên |
| Full range | 1.943 ms | 2.830 ms | 67.166 publishable legs sau quarantine |

Equivalence và tải:

- 18 monthly slices bao phủ 2025-10-25 đến 2027-03-28: expected/actual đều 67.172 candidates; `EXCEPT ALL` hai chiều bằng 0 trên đủ 20 cột.
- Watermark mismatch bị từ chối: expected 49.953, actual 49.954, `DATA_VERSION_CHANGED`.
- 8 request 30 ngày song song trong lúc transaction cập nhật 100 canonical rows và giữ write locks 8 giây: 8/8 đúng 3.817 chuyến, 0 lỗi, median 611 ms, max 750 ms; writer rollback thành công.
- Không có index mới. Tối ưu dùng index `operational_date` hiện hữu cho canonical rows có ngày hợp lệ và giữ fallback cho legacy row thiếu ngày.

Sau khi bổ sung toàn bộ Report feature parity, benchmark end-to-end qua SSH trên clone:

| Range | Full v2 payload | Payload | Recurring rows |
|---|---:|---:|---:|
| 7 ngày | 1.348 ms | 39.269 byte | 0 |
| 30 ngày | 2.288 ms | 76.794 byte | 160 |
| YTD | 7.782 ms | 151.771 byte | 257 |
| Full range | 17.116 ms | 227.681 byte | 324 |

Concurrency sau feature parity, trong lúc transaction clone update 100 canonical rows, giữ lock 8 giây rồi rollback: 8/8 response đúng 3.817 chuyến, 0 lỗi, median 1.845 ms, max 2.246 ms.

Edge subresources dùng internal `payload_scope`: overview=`full`, timeline=`timeline`, dimension/export=`dimensions`. Clone xác nhận timeline/dimensions scoped khớp byte-level JSON của full bundle và cùng watermark. Warm benchmark qua SSH:

| Range | Full | Timeline scope | Dimensions scope |
|---|---:|---:|---:|
| 30 ngày | 2.988 ms / 76.794 B | 2.583 ms / 13.870 B | 2.588 ms / 35.836 B |
| YTD | 10.309 ms / 151.771 B | 6.850 ms / 60.654 B | 7.016 ms / 43.993 B |

Scope giảm đáng kể response serialization và bỏ recurring/detail work khỏi request phụ, nhưng canonical candidate scan vẫn là chi phí nền. Vì vậy đây là tối ưu an toàn cho UI fan-out, chưa đủ để gỡ No-Go YTD/full-range.

Đánh giá: correctness/concurrency gate đạt ở mức rehearsal 8-way, nhưng latency gate **chưa đạt** cho YTD/full-range payload. Trước staging cutover cần profile/tách hoặc lazy-load phần detail nặng, rồi đo p50/p95/p99 ở concurrency 10/50 và qua gateway timeout. Clone test 8-way chưa thay thế load test production-like đầy đủ.

## 5.1 Phát hiện as-of quan trọng

Trước khi refresh clone, v1 và v2 cùng watermark 49.954 nhưng Pax lệch 5.588 ở ngày 30/08/2026. Nguyên nhân không phải canonical row drift:

- v1 khóa `data_as_of` tại lần refresh snapshot 31/08;
- v2 đánh giá live tại 01/09;
- các Pax ngày 30/08 chỉ được tính sau ngưỡng `scheduled_local_at + 1 day`.

Watermark chỉ phản ánh data mutation, không phản ánh time-based maturity. Sau khi refresh **clone-only** và cập nhật projection state ở cùng semantic as-of, KPI/Pax/timeline khớp. Vì vậy shadow comparator phải yêu cầu cả watermark lẫn compatible `data_as_of`, không được kết luận mismatch chỉ từ watermark.

## 6. Validation đã đạt

- Contract unit tests: URL normalize, strict decoder, version envelope, NULL/0/future/missing.
- Adapter unit tests: không gửi credentials, decode aggregate, 409 full reload, retryability.
- PGlite: candidate migration/v2 apply hai lần; exact candidate diff; A/D/all; Pax NULL và true zero; feature-parity peak hour/day-of-week/aircraft; expected watermark mismatch; aggregate-only ACL.
- Clone ACL: `service_role` gọi được public v2 wrapper nhưng không có EXECUTE/USAGE trực tiếp trên row-level candidate Interface.
- Clone concurrency: report read không chờ transaction write và transaction rehearsal rollback sạch.
- Differential clone sau khi đồng bộ semantic as-of: KPI tổng/A/D và Pax khớp; timeline, peak-hour, monthly peak, day-of-week, aircraft group/type đều diff 0; 9 tổ hợp airline/route/country × all/A/D đều diff 0.
- Clone actual-data null handling: 2 due legs có Pax NULL, 3 due legs có Pax 0 và 3.815 reported due legs; không ép NULL thành 0.
- Dashboard source gate: Report Mode chỉ dùng shared adapter, không dùng row-level `FlightRecord` hoặc `buildDashboardOverview`.
- Report source gate: flag mặc định tắt; overview/timeline/dimension/export cùng shared adapter và expected watermark; 409 buộc full reload.
- TypeScript, targeted lint, rule regression và report-only production build 52 file đều đạt.

## 7. Cổng còn lại trước production

1. Profile/tối ưu hoặc lazy-load phần detail nặng để YTD/full-range đạt budget; không frontend-aggregate.
2. Chạy benchmark cold/warm và concurrency 10/50 trên staging, có import đồng thời; chốt p50/p95/p99 và gateway timeout.
3. Deploy API v2 vào staging, giữ UI v1; chạy real v1/v2 differential matrix khi watermark và semantic as-of tương thích.
4. Browser UAT Report và Dashboard Report Mode trên desktop/mobile, xác nhận `—` và `0` đúng.
5. Chỉ sau các gate trên mới xin duyệt production dual-run/cutover.
6. Decommission snapshot/MV/timer là release riêng sau soak window; không nằm trong cutover đầu.

## 8. Quyết định rollback

- Hiện tại: không set feature flag, v1 tiếp tục phục vụ.
- Nếu staging v2 lỗi: remove/disable route v2; không cần rollback dữ liệu vì v2 chỉ đọc.
- Nếu UI v2 đã bật sau này: tắt release flag và quay về v1; giữ nguyên MV/timer trong toàn bộ soak window.
