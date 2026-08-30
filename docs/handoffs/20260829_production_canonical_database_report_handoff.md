# Handoff Database Production: Canonical Flight Leg cho trang báo cáo

Ngày lập: 2026-08-29

Lần cập nhật report page: 2026-08-29

Môi trường: self-hosted Supabase production, PostgreSQL 17.6

Host vận hành: `ops@100.91.158.79`

Database/container: `postgres` / `opsdata-supabase-db`

## 1. Mục đích handoff

Database production đã được chuyển sang cơ chế `canonical flight leg` cho Seasonal, Daily Schedule, thao tác Detailed/Manual và reporting. Tài liệu này là điểm tiếp nối để triển khai hoặc kiểm tra trang báo cáo mà không đọc nhầm raw action history, superseded row hoặc snapshot cũ.

Trạng thái hiện hành:

- Migration canonical, import Daily, reset có audit, import lại file LB và refresh public report đã chạy trên production.
- Dữ liệu Daily trong khoảng `2026-08-23` đến `2026-08-27` hiện là authority đang active.
- Public traffic materialized view đã được cut over sang canonical effective boundary và refresh thành công.
- Frontend/report page đã deploy tại `https://report.ahtops.xyz/reports/traffic` và đã chạy browser UAT công khai sau khi refresh canonical snapshot.
- Các file migration hiện có trong working tree local nhưng chưa được commit; không được coi trạng thái Git là bằng chứng migration history production. Bằng chứng report rollout nằm ở object live, release, backup và acceptance bên dưới.

## 2. Source of truth mà trang báo cáo phải dùng

### Live canonical data

Nguồn đọc chuẩn cho dữ liệu live sau khi gộp Seasonal + Daily authority + Manual/Detailed overlay:

```text
reporting.canonical_effective_flight_legs
```

View này chỉ nối các bản ghi active từ `public.canonical_active_flight_records_v1`, áp dụng effective modifications và bổ sung provenance/version:

- `source_kind`
- `source_batch_id`
- `source_file_hash`
- `supersedes_record_id`
- `lifecycle_changed_at`
- `source_data_version`

### Public traffic report snapshot

Nguồn hiện hành cho public report:

```text
reporting.public_traffic_effective
```

Luồng dữ liệu:

```text
season_flight_records
  -> canonical_active_flight_records_v1
  -> reporting.canonical_effective_flight_legs
  -> reporting.public_traffic_candidates
  -> public traffic ranking/projection
  -> reporting.public_traffic_effective (materialized snapshot)
```

Migration `20260829190000_public_traffic_canonical_cutover.sql` đã thay `reporting.public_traffic_candidates` để đọc canonical effective view. Đây là sửa lỗi bắt buộc: khi candidates còn đọc physical/history rows, ranking quarantine chỉ giữ được 1 row sau atomic replacement dù canonical có 594 active legs.

### Không được dùng làm nguồn báo cáo hiện hành

- Không đọc trực tiếp toàn bộ `public.season_flight_records` mà không áp dụng điều kiện canonical active.
- Không compact bằng cách chọn row mới nhất từ raw `action` history ở frontend.
- Không dùng `public.season_modifications` hoặc bảng legacy added-leg như nguồn độc lập để cộng thêm chuyến.
- Không dùng `daily_schedule_active_days` làm authority hiện hành. Authority Daily nằm ở `public.schedule_replacement_scopes` với `reset_at is null`.
- Không coi `0` Pax là tương đương Pax chưa được báo cáo.

## 3. Các migration đã áp dụng production

Đã áp dụng tuần tự bằng raw `psql`:

1. `20260829150000_canonical_flight_leg_store.sql`
2. `20260829153000_daily_schedule_canonical_commit.sql`
3. `20260829160000_canonical_manual_modifications.sql`
4. `20260829163000_canonical_effective_read.sql`
5. `20260829170000_seasonal_canonical_authority.sql`
6. `20260829180000_daily_authority_reset.sql`
7. `20260829190000_public_traffic_canonical_cutover.sql`

Sau database cutover, report page đã áp dụng thêm bằng raw `psql` trong một transaction cho từng file:

8. `20260829210000_public_traffic_report_pax_presence_contract.sql`
9. `20260829173000_public_traffic_report_canonical_source.sql` — chỉ thêm projection freshness; không định nghĩa lại canonical candidates.

Database này không có bảng `supabase_migrations.schema_migrations` tại thời điểm triển khai. Vì vậy:

- Không suy luận rằng migration đã được ghi ledger của Supabase CLI.
- Bằng chứng rollout là object live, receipt import/reset, số liệu reconciliation, backup và các file SQL tương ứng.
- Trước lần deploy schema tiếp theo cần thống nhất cách baseline/ledger; không chạy lại mù toàn bộ migration chỉ để tạo history.

### Object/contract chính đã thêm hoặc thay đổi

| Nhóm | Object | Vai trò |
|---|---|---|
| Canonical lifecycle | `public.is_canonical_flight_leg_active_v1(...)` | Xác định row active cuối cùng |
| Ops Date | `public.canonical_flight_leg_ops_date_v1(...)` | Ưu tiên `operational_date`; fallback chuyến trước 05:00 về ngày khai thác trước |
| Atomic identity | `public.canonical_flight_leg_occurrence_key_v1(...)` | Key occurrence duy nhất cho active flight |
| Active rows | `public.canonical_active_flight_records_v1` | Loại deleted/superseded terminal state |
| Daily authority | `public.schedule_replacement_scopes` | Authority theo `season_id + ops_date`, kể cả ngày zero-flight |
| Daily stage/commit | `stage_daily_schedule_import_v1`, `commit_daily_schedule_import_v1` | Preview và atomic replace có hash/version guard |
| Daily reset | `preview_daily_authority_reset_v1`, `reset_daily_authority_v1` | Reset permissioned, có confirmation và audit |
| Manual/Detailed | `save_canonical_season_modification_v1`, `remove_canonical_season_modification_v1` | Mutate đúng atomic base; chặn stale resurrection |
| Live reporting | `reporting.canonical_effective_flight_legs` | Boundary chuẩn cho report/query live |
| Public report | `reporting.public_traffic_candidates` | Candidate chỉ lấy canonical effective rows |
| Public snapshot | `reporting.public_traffic_effective` | Materialized snapshot phục vụ public report |
| Snapshot state | `reporting.public_traffic_projection_state` | Lưu watermark, thời điểm refresh, số dòng và trạng thái lần cập nhật |
| Refresh state | `reporting.mark_public_traffic_projection_fresh_v1()`, `reporting.mark_public_traffic_projection_failed_v1(text)` | Ghi nhận riêng refresh thành công/rỗng/thất bại |

## 4. Receipt production và trạng thái dữ liệu hiện tại

Season production:

```text
season_id: season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6
season_code: S26
data_version hiện tại: 16577
server high-water hiện tại: 47548
```

File nguồn cuối cùng:

```text
C:\Users\tuan\Pictures\LB_20260823_20260827.xlsx
raw checksum: d2b590155c723b771d0e65fe55c0af4fb42c2cb3797d4339194cc70e84c56c69
```

### Lịch sử thao tác có audit

| Thao tác | Batch/request | Version / high-water | Kết quả |
|---|---|---:|---|
| Import canonical lần 1 | batch `04911213-c19f-4d82-bc79-4d79b4e767ce`; request `f6d2001d-73e8-5390-bee1-a172657cc2ab` | `16575 / 47546` | 640 cũ bị thay; 596 staged; 594 effective |
| Reset kiểm chứng | request `b5f8319d-c817-4a28-9f9c-2c23117bb6cc` | `16576 / 47547` | terminalize 594 Daily, khôi phục preimage 640, reset 5 scopes |
| Import canonical cuối | batch `1280be3c-f83f-44c0-a1b2-0c442551849c`; request `3531b771-9815-5b97-a990-ebf960e2d739` | `16577 / 47548` | thay 640 cũ; 596 staged; 594 active/effective; rebase 32 overlays |

Final import receipts:

```text
preview hash: b5ba432c4effbfcec308450901dd5c31d800997318a329f7c25c0d45a5ce50f5
canonical checksum: b3515392fdbe420d28904efc0fd258b747835ec2c1f187c69d4f1c85402c021c
raw rows: 596
active/effective rows: 594
terminal deleted rows: 2
Pax-known active rows: 593
effective Pax total: 102307
active occurrence collision groups: 0
lifecycle status/action mismatch: 0
```

Chênh lệch `596 staged -> 594 effective` là do hai atomic flights kết thúc ở trạng thái deleted sau khi rebase overlay; không phải mất dữ liệu ngẫu nhiên.

## 5. Số liệu chuẩn để đối chiếu trang báo cáo

Sau khi refresh, canonical live view và public materialized snapshot cùng trả:

| Ops Date | Flights | Pax-known legs | Reported Pax |
|---|---:|---:|---:|
| 2026-08-23 | 124 | 124 | 22,511 |
| 2026-08-24 | 118 | 118 | 20,061 |
| 2026-08-25 | 111 | 111 | 18,515 |
| 2026-08-26 | 116 | 116 | 20,633 |
| 2026-08-27 | 125 | 124 | 20,587 |
| **Tổng** | **594** | **593** | **102,307** |

Một leg ngày `2026-08-27` chưa có Pax. Trang báo cáo phải biểu diễn đây là `unknown/missing`, không tự đổi thành `0` và không tuyên bố coverage 100%.

## 6. Freshness và snapshot contract

Public materialized view đã refresh lại thành công sau report rollout tại:

```text
snapshot refreshed_at: 2026-08-29 13:42:40.491218+00
Asia/Saigon: 2026-08-29 20:42:40.491218+07
snapshot_source_watermark: 47548
current source high-water: 47548
snapshot rows: 60312
```

Điều kiện snapshot được coi là current:

```text
snapshot có dữ liệu
AND snapshot_source_watermark = current source high-water
```

Trang báo cáo nên hiển thị tối thiểu:

- `refreshed_at` hoặc thời điểm snapshot.
- `snapshot_source_watermark`.
- Trạng thái `current` khi watermark bằng source high-water.
- Trạng thái `stale` khi watermark thấp hơn source high-water.
- Trạng thái `empty/error` riêng, không biến thành zero-data chart.

Materialized view có unique index `public_traffic_effective_business_leg_idx`, nên refresh concurrent đã được dùng:

```sql
refresh materialized view concurrently reporting.public_traffic_effective;
```

Refresh production gần nhất mất khoảng 2 phút 20 giây. Không đặt request UI chờ đồng bộ thao tác này; refresh nên chạy qua job/service vận hành và UI chỉ đọc freshness.

## 7. Query kiểm chứng dành cho người làm report

Các query dưới đây là read-only.

### Canonical live totals theo Ops Date

```sql
with canonical as (
  select effective.*,
    public.canonical_flight_leg_ops_date_v1(
      effective.operational_date,
      effective.scheduled_date,
      effective.date,
      effective.scheduled_time,
      effective.schedule
    ) as ops_date
  from reporting.canonical_effective_flight_legs effective
)
select ops_date,
  count(*) as flights,
  count(pax) as pax_known_legs,
  coalesce(sum(pax), 0) as reported_pax,
  max(source_data_version) as source_data_version
from canonical
where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  and ops_date between date '2026-08-23' and date '2026-08-27'
group by ops_date
order by ops_date;
```

`reporting.canonical_effective_flight_legs` không có cột vật lý `ops_date`; query kiểm chứng phải tính Ops Date bằng hàm canonical như trên. `ops_date` đã được projection sẵn ở `reporting.public_traffic_effective`.

### Public snapshot totals và watermark

```sql
select
  ops_date,
  count(*) as flights,
  count(pax) as pax_known_legs,
  coalesce(sum(pax), 0) as reported_pax,
  max(snapshot_source_watermark) as snapshot_source_watermark,
  max(snapshot_refreshed_at) as snapshot_refreshed_at
from reporting.public_traffic_effective
where ops_date between date '2026-08-23' and date '2026-08-27'
group by ops_date
order by ops_date;
```

Trong materialized view, cột `effective_pax` của candidate được projection thành `pax`. Không dùng `coalesce(pax, 0)` ở mức từng leg để suy luận coverage.

### Daily authority đang active

```sql
select
  ops_date,
  authority_source,
  source_batch_id,
  expected_leg_count,
  data_version,
  committed_at,
  reset_at
from public.schedule_replacement_scopes
where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  and ops_date between date '2026-08-23' and date '2026-08-27'
order by ops_date;
```

Kỳ vọng: 5 rows, `authority_source='daily'`, `source_batch_id` là batch cuối, tổng `expected_leg_count=594`, `data_version=16577`, `reset_at is null`.

### Reconciliation đầy đủ

Dùng artifact:

```text
docs/superpowers/artifacts/2026-08-29-canonical-flight-leg-store-reconciliation.sql
```

Bind `season_id`, `date_from`, `date_to` và `batch_id`, rồi chạy mọi result set ở cùng một source version.

## 8. Contract nghiệp vụ cần giữ ở report page

- `type=all` là một tập hợp gộp A + D; không cộng lại tổng với hai series A/D lần nữa.
- Một `atomic flight` chỉ xuất hiện một lần sau canonical/effective compaction.
- `deleted`, `superseded` và action lịch sử không được render hoặc tính KPI.
- `pax is null` là chưa có số khách; không phải số khách bằng 0.
- Khi tính coverage cần cả `reported_legs` và tổng leg đủ điều kiện (`due_legs` hoặc contract tương đương), không chỉ `sum(pax)`.
- Nếu API timeline còn phân trang 366 ngày và `timeline_has_more=true`, không tuyên bố toàn khoảng ngày đã đầy đủ.
- Cache HTTP/frontend phải phân biệt cache cũ với database rỗng. Watermark là bằng chứng freshness, không chỉ timestamp của request.

## 9. Trạng thái trang báo cáo sau handoff

Database cutover không tự chứng minh report UI đã đúng. Report rollout sau đó đã hoàn tất các điểm sau:

Repo trang báo cáo hiện nằm tại:

```text
C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report
```

Điểm vào cần audit/tiếp tục trước:

```text
app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx
app/src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx
app/src/app/(public-report)/reports/traffic/TrafficReportTrend.tsx
app/src/lib/trafficReportContract.ts
app/src/lib/trafficReportExcelExport.ts
app/supabase/functions/traffic-report/index.ts
app/supabase/tests/public_traffic_report_v1_pglite.mjs
deploy/traffic-report/seasonal-traffic-report-refresh-manual
docs/runbooks/public-traffic-report-deploy.md
```

Working tree của repo report đang có thay đổi chưa commit. Giữ nguyên các thay đổi đó, đọc diff trước khi sửa và không reset/checkout đè lên công việc hiện hữu.

1. API/Edge/RPC của report đọc `reporting.public_traffic_effective`; frontend không đọc raw flight rows.
2. Đã map `flights`, `reported_pax`, `reported_legs`, `due_legs`, trạng thái Pax, watermark và thời điểm refresh.
3. Coverage dùng `pax is not null`: Pax bằng `0` vẫn là số đã báo cáo; chỉ Pax `null` là thiếu. Lỗi đếm 592/594 trước rollout đã được sửa thành 593/594.
4. UI hiển thị trạng thái thân thiện `Dữ liệu đã cập nhật`, `đang chờ cập nhật`, `lần cập nhật chưa thành công` hoặc `chưa có dữ liệu`; không đưa thuật ngữ kỹ thuật vào nội dung chính.
5. Browser UAT công khai đã xác nhận KPI, xu hướng, bảng thị trường/hãng, giờ cao điểm và filter mobile. Report là public nên authenticated UAT không phải điều kiện truy cập.
6. API đã nhận phạm vi liên tục qua năm `2025-12-28` đến `2026-01-05`; domain ngày hiện hành là `2025-10-25` đến `2027-03-28`.
7. Cache production đã xác nhận `MISS -> HIT`; timer refresh vẫn `disabled/inactive` theo boundary manual-refresh hiện hành.

Việc vẫn thuộc phạm vi hệ thống vận hành, không phải report page: xác minh Check-in/Gate/Daily tiếp tục đọc canonical effective contract sau các frontend rollout riêng của các module đó.

Acceptance tối thiểu cho range `23–27/8/2026`:

- Tổng 594 flights, 593 Pax-known legs, 102,307 reported Pax.
- Từng ngày khớp bảng ở mục 5.
- Không duplicate atomic flight.
- Deleted/superseded rows không xuất hiện.
- Snapshot watermark bằng 47548 hoặc bằng high-water mới hơn nếu source đã tiếp tục thay đổi.
- Nếu high-water đã lớn hơn 47548, report phải báo stale cho đến khi refresh xong; không cố ép kết quả về các số cũ trong tài liệu này.

Kết quả production lúc `2026-08-29 20:42:40 +07`:

- 594 flights; 299 chuyến bay đến; 295 chuyến bay đi.
- 593/594 Pax-known legs; coverage 99,8%; 102.307 reported Pax.
- Projection `fresh`; snapshot watermark `47548` bằng source high-water `47548`.
- Trang `https://report.ahtops.xyz/reports/traffic?from=2026-08-23&to=2026-08-27&comp=none` hiển thị đúng các số trên.

## 10. Backup và rollback boundary

Backup trước canonical rollout đang được giữ tại production host:

```text
/home/ops/seasonal-rollouts/canonical-20260829-afKdBv/postgres-pre-canonical-full.dump
SHA-256: 1f424571eb29313554a708a16c9575c36ce5a06a5219a18fb00e294c07b24547
Kích thước: khoảng 47.5 MB
```

Đây là full database backup trước rollout. Restore là thao tác phá huỷ trạng thái phát sinh sau backup và phải có maintenance window, backup mới, kế hoạch downtime và phê duyệt riêng. Không restore chỉ để xử lý lỗi mapping của report page.

Temporary rehearsal database và payload tạm đã được xoá sau kiểm chứng; backup trên vẫn được giữ.

Backup riêng trước report adjustment và release quay lui:

```text
/home/ops/seasonal-rollouts/report-canonical-adjustment-20260829T134500Z/pre-report-schema.sql.gz
previous release: /srv/seasonal-traffic-report/releases/20260829T063928Z-5ec9653dac35
current release: /srv/seasonal-traffic-report/releases/20260829T134500Z-canonical-adjustment
```

Rollback report page không yêu cầu restore full database: chuyển symlink `current` về previous release, khôi phục service unit đã backup, và khôi phục riêng function/schema report từ backup sau khi đánh giá dữ liệu phát sinh. Không đụng canonical flight-leg store.

## 11. Bằng chứng kiểm thử liên quan

Đã pass local sau các patch cuối:

```text
npm run test:canonical-flight-store
npm run test:daily-canonical-commit
npm run test:canonical-manual
npm run test:seasonal-canonical-authority
```

Production reconciliation đã xác nhận:

- 0 active occurrence collision groups.
- 0 lifecycle status/action mismatch.
- Canonical live totals khớp public materialized snapshot.
- Tất cả Supabase containers healthy sau rollout.
- Report contract/PGlite/isolation tests và production build pass sau Pax/freshness patch.
- Production API range `2026-08-23` đến `2026-08-27` trả 594 flights, 593 reported legs, 594 due legs, 102.307 Pax và projection `fresh`.
- Browser UAT mobile xác nhận filter mở trong dialog riêng, có Đóng, Đặt lại và Áp dụng; khi đóng, nội dung báo cáo tiếp tục đọc được.

Những kết quả này xác nhận database contract, report API và public browser UAT tại thời điểm rollout; UAT thiết bị vật lý vẫn là lớp kiểm chứng riêng nếu cần chấp nhận theo thiết bị cụ thể.
