# Deep Audit — Database Versioning & Action-based Queries

**Ngày đánh giá:** 2026-10-08.  
**Phạm vi:** source hiện tại trong checkout; schema nền + chuỗi forward migrations, query Seasonal/Operations/Report/Dashboard, adapters phía client; hai probe PostgreSQL local read-only.  
**Ràng buộc:** không sửa code/schema, không apply migration, không ghi dữ liệu nghiệp vụ. Báo cáo này là file duy nhất được tạo cho audit.

## 0. Kết luận điều hành

**Giữ hướng kiến trúc hiện tại của nhánh native; không cần thay toàn hệ thống bằng Event Sourcing. Cần tái cấu trúc có mục tiêu trước khi tăng mạnh lịch sử và tải báo cáo.**

1. Tiền đề “lưu mọi version trong bảng chính và replay action để query Daily” **không đúng với đường native trong source**. Planning version metadata, snapshot và diff nằm ở các bảng riêng; Daily native query trạng thái active bằng keyset.
2. Legacy dùng **CRUD + row overlay + audit log**, không phải replay toàn chuỗi event. Native dùng **Current State + audit/history riêng + read projection kiểu CQRS**. Chưa phải Event Sourcing: log không phải nguồn duy nhất để tái dựng toàn trạng thái.
3. Rủi ro ưu tiên cao: refresh toàn bộ projection và mirror bằng `TRUNCATE`; group recency trên toàn event khi tập candidate lớn; JSON snapshot paging không có index ở cấp flight; preview/history/receipt chưa có lifecycle cleanup được tìm thấy trong phạm vi khảo sát.
4. Toàn vẹn đã có nhiều fence thực: revision/epoch, locks, receipts, composite FK, Daily authority, collision rejection, quarantine và stale fail-closed. Không được bỏ chúng để giảm latency.
5. Snapshot “immutable” hiện được bảo vệ bằng grants/RLS và đường RPC, chưa tìm thấy trigger chống UPDATE/DELETE cho các bảng Planning published. Restore/export không tính lại checksum snapshot. Đây là khoảng trống bảo vệ trước sửa đổi ngoài API, không phải bằng chứng dữ liệu hiện đã hỏng.
6. **Không kết luận trạng thái production từ checkout hoặc DB local.** Tài liệu triển khai ghi separation chưa lên production; audit này không đăng nhập production để xác minh lại.

### Cách đọc bằng chứng

- **[SOURCE]**: quan sát trực tiếp trong file và câu SQL được dẫn.
- **[MEASURED-LOCAL]**: chạy SELECT/EXPLAIN trong transaction read-only trên DB disposable có sẵn.
- **[DOCUMENTED]**: bằng chứng của phiên trước đã ghi trong repo, không đo lại ở audit này.
- **[INFERENCE]**: hệ quả kỹ thuật từ cấu trúc/query, chưa có benchmark 10–100 lần.

Đường dẫn trong báo cáo tính từ root repo. Các line range là mốc của checkout lúc khảo sát; tên function/table là neo khi file thay đổi. Rollback không được coi là định nghĩa forward đang có hiệu lực.

## 1. Current Architecture Audit

### 1.1. Source current khác deployment current

`app/supabase/schema.sql` là schema nền; các forward migrations thay đổi định nghĩa sau đó. Chỉ đọc schema nền sẽ bỏ sót native separation và các bản sửa ngày 08/10.

`docs/current-implementation-status.md:9–34` ghi:
- 06/10 production chỉ triển khai migration tối ưu commit `20261006093000`, không triển khai separation/cutover.
- Hai feature gate desktop mặc định OFF; staging đã bật native readers.
- Tài liệu tự cảnh báo receipt/plan không chứng minh live state (`:7`).

**Kết luận phạm vi:** mô tả cả legacy khi gate OFF và native khi gate ON. Không gán runtime native local cho production. Không dùng kết quả API public cũ ngày 04/09 như quan sát mới hôm nay.

### 1.2. Bảng và vai trò thực tế

| Nhóm | Bảng/cột chính | Vai trò, không được nhầm lẫn |
|---|---|---|
| Legacy current | `season_flight_records`: `record_id`, `season_id`, `status`, `action`, scheduled/operational date | Base/canonical row hiện tại, không phải mỗi action là một version riêng |
| Legacy overlay | `season_modifications`: `leg_id`, `action`, `changed_fields`, các giá trị sửa | Overlay hiện tại theo leg; query chọn trường trong changed_fields |
| Legacy log | `season_change_events.server_seq`, `target_id`, `target_type`; `season_mod_history_entries` | Audit/sync/conflict/recency; không replay tất cả before/after để tính Pax |
| Planning current | `seasonal_flight_drafts`, `seasonal_draft_workspace.epoch/revision` | Draft hiện hành, scalar và child resources |
| Planning events | `seasonal_draft_events.before_state/after_state/changed_fields/server_seq` | Audit và conflict/undo, tách khỏi current |
| Publish metadata | `seasonal_publish_versions.version_id/version_tag/publish_sequence/snapshot_checksum` | Một dòng cho một lần release/reapply thực; true no-op không tạo version mới |
| Publish snapshot | `seasonal_publish_snapshots.version_id/snapshot_payload/checksum` | Full JSON của Planning tại Publish, một snapshot theo version |
| Publish delta | `seasonal_publish_diff_entries.base_version_id/change_type/before_state/after_state/entry_index` | Diff lưu sẵn theo cặp lúc Publish, không phải operational event stream |
| Preview | `seasonal_publish_previews.planning_snapshot/preview/result/expires_at`; preview/impact entries | Candidate snapshot và diff trước Publish; committed row còn giữ receipt |
| Operations current + tombstone | `operational_flight_legs.leg_id/status/lineage_id/lineage_generation/published_version_id` | Active state cập nhật tại chỗ; retired generations cũng còn trong cùng heap |
| Operations log | `operational_change_events.target_id/target_type/server_seq/before_state/after_state` | Audit, recency, notifications và Pax correction |
| Authority/override | `operational_day_authority`, `operational_resource_overrides.fields` | Daily day authority và field mask, không phải suy từ timestamp mới nhất |
| Reporting read model | `operational_canonical_flight_legs`, `canonical_flight_legs`, state/quarantine | Các bảng projection đã resolve identity, phục vụ aggregate |
| Dashboard publication | `reporting.public_dashboard_publications`, dirty markers | Publication ledger + trạng thái correction coalescing, khác Planning versions |

Nguồn schema native: `app/supabase/migrations/20260928120000_seasonal_operational_separation_schema.sql:26–228,253–367`; bổ sung lineage/override: `20260928180000_operational_daily_import_v2.sql:9–16`; workspace/version sequence: `20260928190000_seasonal_planning_v1.sql:14–30`; operational events: `20260928170000_operational_mutations_v1.sql:17–38`.

### 1.3. Legacy: overlay, không phải event replay

`app/supabase/migrations/20260831205000_public_traffic_candidate_slice_v1.sql:39–95`:

```sql
from public.season_flight_records records
left join public.season_modifications modifications
  on modifications.season_id = records.season_id
 and modifications.leg_id = records.record_id
where public.is_canonical_flight_leg_active_v1(records.status, records.action)
```

Giá trị effective dùng mask, không lấy action mới nhất bằng timestamp:

```sql
case when 'pax' = any(base.changed_fields)
     then base.modified_pax else base.base_pax end as pax,
coalesce(base.modification_action, base.base_action, 'active') as effective_action
```

`changed_fields` phân biệt “không sửa” và “sửa thành NULL”. Dùng `COALESCE(modified_pax, base_pax)` thay thế sẽ làm sai nghiệp vụ NULL; không đề xuất cách đó.

Client cũng materialize overlay: `app/src/lib/effectiveSeasonalLegs.ts:21–50,82–119` kiểm persisted deletion, thêm added leg nếu chưa có, áp modified fields và loại deleted. `pax/gate/counter` dùng kiểm tra tồn tại thuộc tính để giữ explicit NULL. Đây là logic precedence theo state, không vòng replay mọi history event.

**Phân loại:** CRUD canonical có row overlays và audit log. Độ phức tạp đến từ nhiều nơi cùng biểu diễn effective state, không đủ bằng chứng gọi là “Event Sourcing nửa vời”.

### 1.4. Native: current state + full snapshot + delta

`app/supabase/migrations/20261008090000_seasonal_publish_safety_v1.sql:803–850`:
- INSERT version metadata và full `planning_snapshot` vào snapshot table.
- Copy preview entries thành published diff.
- INSERT leg mới; UPDATE leg active hiện có; soft-delete leg bị retire.

```sql
insert into public.seasonal_publish_snapshots
  (version_id,season_id,snapshot_payload,flight_count,checksum)
values(v_version,p_season_id,p.planning_snapshot,
       (p.planning_snapshot#>>'{counts,active}')::integer,p.draft_checksum);

update public.operational_flight_legs l set
  -- scalar/resources hiện tại ...
  published_version_id = v_version
-- cập nhật leg active tương ứng, không nhân bản toàn mùa mỗi Publish
```

Bảng chính **không chứa full history của mỗi Publish**, nhưng không phải bảng “chỉ active đúng một entity”: tombstones/generations vẫn lưu chung. Partial unique `(source_season_id,source_draft_id)` áp cho active published legs; unique `(lineage_id,lineage_generation)` kiểm lineage. `leg_key` không unique toàn bảng, có chủ ý.

`20260928120000...sql:338–345` giải thích: operational lookup key dùng operational date; reporting business key dùng **scheduled date + side + airline + flight number**. Hai chuyến khác calendar day có thể nằm chung ngày khai thác mốc 05:00. **Không thêm UNIQUE(leg_key) như một quick-win.**

### 1.5. Daily native không query action log

`app/supabase/migrations/20260928170000_operational_mutations_v1.sql:303–402`:

```sql
select l.* from public.operational_flight_legs l
where l.status = 'active'
  and l.operational_date between p_start_date and p_end_date
  and (p_after_leg_id is null or
       (l.operational_date,l.scheduled_time,l.leg_id) >
       (p_after_operational_date,p_after_scheduled_time,p_after_leg_id))
order by l.operational_date,l.scheduled_time,l.leg_id
limit p_page_size + 1;
```

Partial index đã có: `operational_flight_legs_day_keyset_idx(operational_date,scheduled_time,leg_id) WHERE status='active'` (`20260928120000...:347–349`).

RPC STABLE đọc revision và rows trong statement snapshot; token chứa epoch/revision/date range/resource type. Revision khác trả `snapshot_changed`, không trả page trộn. Child counters/windows và linked legs lấy theo ID của page; authority lấy theo date range. Catalog resources vẫn được aggregate toàn catalog khi loại resource yêu cầu (`:349–364`), không giới hạn theo số leg trên page.

### 1.6. Report: action ở candidate seam, event ở recency, aggregate trên projection

Legacy candidate lấy effective row từ base/overlay, rồi recency:
`20260831205000_public_traffic_candidate_slice_v1.sql:119–142` dùng `max(server_seq)` theo target, không replay payload.

Native union event nguồn:
`20260928170000_operational_mutations_v1.sql:55–58`:

```sql
select target_id,target_type,server_seq from public.season_change_events
union all
select target_id,target_type,server_seq from public.operational_change_events;
```

Native candidate (`:434–507`) đọc active legs; `effective_action` trả literal `'active'`; event chỉ cung cấp authoritative recency. Có hai nhánh:

```sql
-- candidate < 10000: join selected target IDs
-- candidate >= 10000:
select events.target_id, max(events.server_seq)::bigint as server_seq
from reporting.operational_projection_events_v1 events
cross join bounded_stats
where bounded_stats.candidate_count >= 10000
group by events.target_id;
```

Recency fallback: entity event → day authority event → captured backfill sequence. `server_seq` là thứ tự sequence, **không phải bằng chứng wall-clock/commit order tổng quát**. Giữ writer locks/transaction consistency, không đổi ranking sang timestamp để “đơn giản hóa”.

Projection resolve Daily eligibility trước, rồi rank theo business key. Missing/tied recency khi có nhiều candidate bị quarantine, không âm thầm chọn một dòng (`20260928170000...:603–666`; forward cutover mang tiếp logic ở `20260929120000_seasonal_operational_reader_cutover_v1.sql`).

Cutover forward:
- `reporting.flight_operations` chọn legacy/native theo gate (`20260929120000...:288–295`).
- `refresh_operational_canonical_legs_v1` full-build và mirror khi gate ON (`:520–532`).
- `get_public_traffic_report_v2` freshness/generation gate rồi aggregate canonical (`:569` trở đi).
- KPI native aggregate canonical; publication/dirty markers quản lý HEAD riêng, không replay Planning versions để tính tổng.

**Phân loại:** CQRS-style derived tables trong cùng PostgreSQL, không phải read replica; regular projection tables không tự trở thành PostgreSQL materialized views chỉ vì vai trò giống MV.

## 2. Risk Assessment Matrix

Mức đánh giá là ưu tiên thiết kế, không khẳng định incident đã xảy ra. Tách rủi ro còn tồn tại với lỗi đã có fence.

| Trục | Mức | Bằng chứng thực tế | Safeguard hiện có | Rủi ro còn lại / hành động |
|---|---|---|---|---|
| Integrity: overlay precedence | Trung bình, cao nếu duy trì hai write paths lâu dài | Legacy mask/action SQL và client materializer ở §1.3 | Explicit field masks, persisted deletion guard, canonical mutations | SQL/TS semantics có thể drift. Chốt một nguồn current authoritative, migrate caller khi cutover; không dùng timestamp replay |
| Integrity: concurrency | Trung bình sau fence | Operational mutation khóa singleton revision trước, ngày rồi leg (`20260928170000...:129–149`); restore epoch/revision/receipt (`20261008100000...:418–456`) | Exact receipts, expected preimages, deterministic lock order; Publish recheck dưới lock | Direct SQL bỏ RPC có thể vượt nghiệp vụ; nhiều writer vẫn contention. Không nới fence để tăng throughput |
| Integrity: duplicate/recency | Trung bình | Reporting key khác operational key; max sequence + quarantine (§1.6) | Daily authority, collision checks, quarantine | Không thể coi một UNIQUE trên operational leg_key là đủ. Retention event phải giữ recency authoritative trước khi xóa log |
| Integrity: snapshot bất biến | Trung bình | Snapshot FK cascade và SELECT grants/RLS (`20260928120000...:171–183,457–466,508–511`); restore đọc payload (`20261008100000...:459` trở đi) | API không có update snapshot, owner-season checks, checksum lưu sẵn | Chưa thấy immutability trigger; restore/export không recompute hash. Thêm guard và checksum verification có đường maintenance rõ ràng |
| Query latency: native Daily | Thấp theo số version, trung bình theo tải write | Keyset active index và statement snapshot (§1.5) | Bounded page/range, snapshot_changed | Catalog repeated; global revision gây retries dù đổi ngày khác. Nhiều version không tự khiến Daily replay nhiều event |
| Query latency: projection | Cao khi data/event tăng lớn | Full event GROUP BY nhánh ≥10000; full build/rank/TRUNCATE/mirror | Worker ngoài mutation, single-flight, stale fail-closed | Chi phí theo active data + event history; reader dài chặn refresh. Dùng recency current và incremental projection theo affected scope |
| Query latency: History | Cao khi snapshot lớn / duyệt nhiều page | `jsonb_array_elements`, normalization, count, order mỗi page; arbitrary diff tính lại (§3) | Page size giới hạn response; stored diff indexed | Page size không giới hạn scan/decompression. Chuẩn hóa snapshot flight rows hoặc cache diff theo checksum |
| Storage/index bloat | Trung bình→cao theo retention | Full JSON mỗi version + preview + before/after log; tombstones cùng heap | TOAST, active partial indexes, true no-op không tạo version | Không tìm thấy lifecycle cleanup trong source khảo sát. Đo live/dead/TOAST/index trước partition/archive |
| Maintainability | Cao ở giai đoạn hai kiến trúc cùng tồn tại | Legacy overlay SQL/TS, native mapper, dynamic preimage capture và gates | RPC contracts, parity baseline, gated cutover | Cần kết thúc dual-path có điều kiện; không thêm abstraction event engine thứ ba |

### 2.1. Integrity: không kết luận sai vì có action/event

Không thấy query `sum(+added -deleted)` dựng số chuyến từ mọi action trong những read paths khảo sát. Report sum/count trên effective/canonical rows. Nguy cơ thật là chọn effective state/identity/authority sai, không phải bản thân tên cột `action`.

Operational mutation (`20260928170000...:131–140`) kiểm receipt **trước** stale revision rejection để retry sau mất ACK vẫn nhận đúng kết quả. Restore cũng kiểm receipt trước expected epoch/revision (`20261008100000...:430–444`). Xóa receipt tùy tiện sẽ phá cam kết replay này.

Pax correction native chỉ capture event chứa `pax` và đúng target type, gate ON; trigger `operational_capture_zzz_pax_correction` được đặt sau resource override capture (`20261008110000_operational_reporting_correction_v1.sql:48–60,181–189`). Rename trigger/đổi thứ tự mutation phải giữ generation coverage. Generation không được đồng nhất tùy tiện với native `server_seq`.

Snapshot checksum verification là defense-in-depth trước sửa ngoài API, không bảo vệ tuyệt đối trước superuser cố ý sửa cả payload và checksum. Grants/RLS không tự ngăn mọi thao tác privileged; quyền service role cụ thể còn phụ thuộc grants triển khai, không suy diễn “bypass RLS = có mọi quyền SQL”.

## 3. Các bottleneck cần phân biệt

### 3.1. Snapshot paging là response paging, chưa phải indexed storage paging

`app/supabase/migrations/20261008100000_seasonal_version_management_v1.sql:121–148`:

```sql
from jsonb_array_elements(v_snapshot.snapshot_payload->'flights') f
-- normalize mỗi flight, lọc active
where p_after_draft_id is null or draft_id > p_after_draft_id
order by draft_id limit p_page_size + 1;
-- totalCount vẫn count toàn active_flights
```

[SOURCE] Chỉ index row snapshot theo version, không có B-tree trên từng `draft_id` bên trong JSON array. [INFERENCE] Với N flights và P pages, duyệt toàn phiên bản có thể lặp công việc cỡ P×N, cộng sorting/normalization/decompression; không tuyên bố mỗi page chỉ O(page_size). TOAST compression tiết kiệm dung lượng, không bỏ chi phí đọc/unpack.

Arbitrary diff (`:203–249`): cặp có stored entries dùng `(version_id,entry_index)`; cặp tùy ý gọi `seasonal_planning_diff_v1` trên hai full snapshots và `row_number()` lại mỗi page. Cặp unchanged không có stored entries cũng rơi vào fallback. UUID diff row được sinh lại không nên dùng làm identity ổn định giữa requests.

### 3.2. Full refresh + mirror + dài hạn event growth

`20260928170000_operational_mutations_v1.sql:536–540,570–696` build/rank toàn bounds, `TRUNCATE`, insert projection và cập nhật source generation. Latest cutover thêm mirror `TRUNCATE reporting.canonical_flight_legs` và copy toàn operational projection (`20260929120000...:520–532`).

[INFERENCE] Hai read-model copies tăng write/index/WAL và buffer pressure. Full refresh chi phí không tỷ lệ với số leg vừa sửa; sự kiện tăng 100× có thể tăng bước global recency group dù active flights không đổi. Index không làm biến mất aggregate toàn event.

[DOCUMENTED] `docs/superpowers/plans/2026-09-28-seasonal-operational-separation-implementation-plan.md:349–361` ghi workload local 250.000 legs: full refresh đầu 15.649 ms, refresh gặp reader lock 17.651 ms, catch-up 16.676 ms; writer resource 140 ms. Đây là số đo phiên trước, **không chạy refresh hay lock probe lại trong audit này**. Reader giữ relation lock có thể kéo dài Report/projection lag; writer nhanh không chứng minh reader không block.

### 3.3. Singleton revision là serialization toàn workspace

`20260928160000_operational_window_v1.sql:17–40` statement triggers tăng một singleton; `20260928170000...:131` mutation `FOR UPDATE` singleton trước thao tác. Catalog, authority, counters/windows và overrides cùng bump revision.

[SOURCE] Đây là fence consistency thật. [INFERENCE] Hai writer ở hai ngày khác nhau vẫn tranh cùng row; mọi date-window token có thể invalidated bởi sửa ngoài range. Nếu cần sharding, phải thiết kế scope revision/generation và lock order đầy đủ cho multi-day/overnight/Daily/Publish, không đơn giản bỏ lock.

### 3.4. Storage growth không đồng nghĩa PostgreSQL bloat

Phân biệt:
- **Logical growth**: versions, events, receipts, retained tombstones còn sống.
- **MVCC bloat**: dead tuples sau UPDATE/DELETE, cần autovacuum/statistics/đo thực.
- **Index/TOAST growth**: cấu trúc riêng, không thể suy từ row count.

[INFERENCE] Full snapshots có growth cỡ V×N×payload; diff/log còn lưu before/after; preview cũng chứa full planning snapshot. Index active không chứa tombstones, nhưng heap/PK/history indexes vẫn chứa chúng. Thêm một version Planning không nhân bản toàn operational heap; Daily replacement/retire/reactivate có thể tăng generations.

`seasonal_publish_previews.expires_at` mặc định 2 giờ (`20260928190000...:243–261`) là **expiry validation, không phải TTL tự xóa**. Search source supabase/scripts không tìm thấy cleanup thực cho preview/snapshot/event ngoài tests. Không khẳng định host không có job ngoài repo.

## 4. Probe read-only trong audit này

DB có sẵn: `sm_planning_review_20261008`, PostgreSQL 17.11 local. Các lệnh chạy dưới `BEGIN READ ONLY`, `statement_timeout=20s`, kết thúc `ROLLBACK`; không tạo fixture/migration/index, không refresh. DB synthetic từ phiên trước, không đại diện distribution production.

### 4.1. Daily representative query

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT leg_id, operational_date, scheduled_time
FROM public.operational_flight_legs
WHERE status='active'
  AND operational_date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'
ORDER BY operational_date, scheduled_time, leg_id LIMIT 501;
```

| Phép đo | Kết quả |
|---|---:|
| Rows trả | 501 |
| Execution time | 4,741 ms |
| Planning time | 19,774 ms |
| Shared blocks read | 9 |
| Heap fetches | 2 |

Plan: `Index Only Scan` qua `operational_flight_legs_day_keyset_idx`, không Sort/event scan. **Chỉ query chọn ba cột**, không toàn RPC `l.*`/JSON/catalog/auth/transport. Không dùng làm SLA Daily.

### 4.2. Aggregate canonical cả năm

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ops_date, count(*), sum(pax)
FROM reporting.canonical_flight_legs
WHERE ops_date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'
GROUP BY ops_date;
```

| Phép đo | Kết quả |
|---|---:|
| Groups trả | 365 |
| Execution time | 82,090 ms |
| Planning time | 3,180 ms |
| Shared blocks hit | 3.103 |
| Workers launched | 2 |
| Temp disk I/O | 0 |

Plan parallel Seq Scan → partial HashAggregate → sort/Gather Merge. Whole-year query chọn gần toàn bảng; sequential scan hợp lý, không chứng minh thiếu index. Sort chỉ 365 groups/worker, 39 KiB; không thấy spill ở lượt này. Chưa đo full overview RPC, cold/warm repeats hay 10–100×.

### 4.3. Dung lượng local quan sát

`pg_total_relation_size` gồm heap, TOAST và indexes; `pg_indexes_size` là phần index. `reltuples` là estimate, -1 không nghĩa bảng rỗng.

| Bảng | Estimated rows | Total bytes | Index bytes |
|---|---:|---:|---:|
| `operational_flight_legs` | 250.000 | 134.430.720 | 83.673.088 |
| `canonical_flight_legs` | 250.003 | 43.704.320 | 18.374.656 |
| `operational_canonical_flight_legs` | 250.003 | 43.704.320 | 18.374.656 |

Snapshots W88 local chỉ 3 flights/version, `pg_column_size` 1.273 và 1.308 bytes: **không ngoại suy dung lượng snapshot W26 hoặc production từ hai mẫu này**. Chưa đo dead tuples/autovacuum/cache residency; không kết luận physical bloat đã xảy ra.

Catalog index probe xác nhận local: `operational_change_events(target_id,server_seq)`; legacy `(season_id,server_seq)`, `(season_id,target_id,server_seq DESC)`, `(season_id,target_type,server_seq DESC)`. Chưa thấy global leading `server_seq` ở các index được liệt kê. Đề xuất index cho `max(server_seq)` phải EXPLAIN workload thực trước; index target hiện có đã dùng được cho target lookup backward scan.

## 5. Dự báo khi version/action tăng 10–100 lần

Tất cả dự báo sau là **[INFERENCE]**, không số đo capacity.

| Cái gì tăng | Native Daily | History / Publish | Report / Dashboard |
|---|---|---|---|
| V tăng, N active giữ nguyên | Không replay V; gián tiếp cache/disk cạnh tranh | Registry index vẫn page; snapshot total storage tăng theo V; mỗi selected snapshot vẫn theo N | Không aggregate Planning versions; ảnh hưởng tài nguyên DB chung |
| N tăng 10–100× | Keyset page bounded nhưng heap/index lớn hơn; full-window nhiều pages hơn | Full JSON normalize/diff/restore lớn hơn; latency và memory/network tăng | Full projection/window ranking + full-year aggregate lớn hơn |
| E event tăng 10–100×, N giữ nguyên | Không scan E cho page native | Logs/receipts growth, conflict lookup cần index | Global recency group và watermark queries có thể tăng theo E |
| T retired generations tăng | Active partial index tránh T; heap/PK vẫn tăng | Lineage seed/history lookup/index lớn | Active selection tránh phần retired nhưng tài nguyên chung chịu áp lực |
| Concurrency tăng | Global revision lock, stale retries tăng | Publish/restore giữ lock lâu hơn | Worker lag/refresh queues, reader lock và generation churn |

Không nhân latency 82 ms hoặc 15 s với 100 để cam kết thời gian. CPU/I/O, sort spill, cache miss, selectivity và parallelism thay đổi không tuyến tính.

## 6. Trade-off Matrix

Ba mô hình có thể phối hợp, không phải ba lựa chọn loại trừ nhau.

| Tiêu chí | Hiện tại legacy/native | Mô hình 1: Current + History | Mô hình 2: Periodic Snapshot + Delta | Mô hình 3: Read model / MV / Replica / CQRS |
|---|---|---|---|---|
| Đọc Daily | Legacy overlay; native current keyset | Đơn giản nhất: current authoritative | Không nên replay delta trong request Daily | Dùng current/window read model phù hợp |
| Audit/version | Full Planning snapshots + stored diff + logs | Audit riêng, full snapshot vẫn có thể giữ | Giảm snapshot duplication nhưng replay phức tạp | Publication/read-model generation riêng, không thay audit |
| Restore/export version | JSON trực tiếp, ít replay | Snapshot relational indexed hoặc immutable artifact | Phải checkpoint + replay đúng schema/order | Projection không thay recovery snapshot |
| Hiệu năng Report | Full canonical refresh và aggregate | Aggregate current dễ hơn nhưng còn tranh OLTP | Replay làm nền, không dựng report mỗi request | Tách compute/read, có lag và freshness contract |
| Dung lượng | V×full snapshot + E + T + mirrors | History archive/partition độc lập, current gọn | Snapshot ít hơn, delta phải đủ để rebuild | Thêm projection/replica storage, WAL/replication |
| Toàn vẹn | Nhiều fence hiện có; dual path khó bảo trì | Một current truth; audit cùng transaction | Event completeness/ordering/schema evolution khó hơn | Atomic generation + stale policy + idempotent worker bắt buộc |
| Độ khó migrate | Đang có gated cutover | Native đã gần mô hình này | Lớn; chưa có log completeness guarantee để dùng ngay | Đã có CQRS-style; cần incremental refresh hơn là dựng lại |
| Khuyến nghị | Kết thúc legacy dual-path có nghiệm thu | **Mô hình nền nên giữ** | Chỉ khi storage chứng minh cần, không mặc định | **Bổ sung có mục tiêu cho Report scale** |

Materialized view concurrent refresh có điều kiện/index riêng và vẫn compute lại dataset; không tự incremental. Read replica giảm tải đọc nhưng không sửa query replay/recency sai, không bỏ replication lag/freshness validation. Không chọn replica trước khi đo primary workload và định nghĩa generation được đọc.

## 7. Architectural Recommendations

### 7.1. Quick wins — không đổi nghiệp vụ

| Ưu tiên | Việc đề xuất | Tiêu chí nghiệm thu |
|---|---|---|
| P0 | Inventory live function definitions, gate/build flags và worker jobs bằng read-only trước rollout | Đối chiếu latest forward/preimage; không dựa schema.sql hay receipt cũ |
| P0 | Theo dõi projection lag, refresh duration, lock waits, stale retries, query rows/temp bytes, dead tuples/TOAST/index size | Baseline theo workload thật; cảnh báo lag không làm fresh giả |
| P1 | Chính sách cleanup preview expired **chưa committed**, child rows cascade; giữ receipt committed theo retry horizon rõ ràng | Lost-ACK retry không bị phá; audit retention được duyệt; không xóa full history tùy tiện |
| P1 | Kiểm checksum canonical payload trên restore/export và enforce published immutability trong write boundary | Sửa ngoài API bị phát hiện; maintenance/rollback không tạo bypass chung |
| P1 | EXPLAIN event max/target/day lookup và conflict predicates, chọn index theo plan thực | Không thêm trùng day keyset index, không UNIQUE sai business identity |
| P1 | Cache arbitrary diff theo `(base_checksum,target_checksum,diff_algorithm_version)` hoặc relational stored comparison | Pagination ổn định, không tính lại full diff mỗi page; invalidate theo algorithm |
| P1 | Review giảm lặp catalog payload trên window paging | Giữ resource/snapshot coherence; không dùng cache stale allocation |

Mọi index ở đây là **đề xuất**, chưa tạo migration. Global `server_seq` index chỉ cải thiện max lookup nếu planner/workload chứng minh; không giải quyết full event GROUP BY.

### 7.2. Refactor ưu tiên: indexed immutable snapshot flights

Giữ version registry và snapshot recovery boundary, thêm storage quan hệ cho flight rows theo version, ví dụ logical key `(version_id,draft_id)` cùng owner-season constraints. Child counters/windows cần thứ tự ổn định và FK. Đây là thiết kế đề xuất, không schema đã tạo.

- History paging: B-tree seek thực theo version/draft ID thay vì unpack toàn JSON mỗi page.
- `totalCount` dùng metadata đã kiểm chứng khi publish; không count full JSON trên mọi page.
- Giữ full artifact JSON cho recovery/export nếu cần; tránh hai nguồn authoritative bất đồng bằng write transaction + checksum/reconciliation. Có thể chọn relational snapshot làm authoritative và sinh artifact từ nó; cần quyết định một chiều rõ ràng.
- Không ép đổi template Excel hoặc business identity để tiện index.

Nghiệm thu: page đầu/giữa/cuối trên mùa lớn; arbitrary diff cùng snapshot semantics; export round-trip pairing/counters/NULL/0; restore exact receipt và Operations không đổi. Scan work mỗi page không tăng theo toàn N khi index seek đủ.

### 7.3. Refactor recency current, không replay history trên read path

Lưu authoritative recency vào current leg/day state hoặc một bảng lookup current riêng. Cập nhật cùng transaction với mutation/import/publish; backfill từ resolver hiện tại và giữ quy tắc precedence entity/day/captured lineage.

- Audit log vẫn append; projection không GROUP BY toàn lịch sử để tìm latest state mỗi refresh.
- Không tạo “latest timestamp” thay server_seq/authority policy.
- Chỉ archive event sau khi current recency, conflict/undo/retry consumers không còn cần raw history trong horizon đó.
- Parity bắt buộc cho Daily priority, missing/tied recency quarantine, source key qua mốc 05:00 và NULL/0.

### 7.4. Incremental report projection theo affected scope

Đích: coalesce affected dates/business keys từ transaction event/outbox; resolve lại **toàn bộ candidates trong scope đó**, không chỉ cập nhật leg mới nhất rồi bỏ sót counterpart/winner.

- Dirty old+new operational/scheduled dates khi move/rekey; overnight counterparts và authority zero-flight cũng dirty.
- Update projection và generation coverage atomically; source generation được claim phải thực sự cover mọi change tới đó, không `max(seq)` giả định liên tục/commit order.
- Coalescing + single-flight; retry idempotent; durable queue và timer fallback.
- Đừng TRUNCATE toàn read model cho mỗi mutation. Có periodic full reconciliation để phát hiện drift.
- Có thể thêm daily/dimension rollups sau khi đo aggregate nặng; giữ exact NULL Pax semantics, coverage/quarantine, pinned version export.
- Giảm hai physical canonical copies bằng một authoritative read model/cutover interface khi parity consumers đủ; không đổi view/contract giữa rollout mà thiếu migration.

Nghiệm thu: concurrent read/write, commit đảo thứ tự, rollback, notification mất, worker restart, move qua năm, Daily replacement/zero, no-op, quarantine delta. Không đánh dấu fresh chỉ vì job kết thúc.

### 7.5. Cold history/archive và scoped revision chỉ sau số đo

- Partition/archive audit theo retention phù hợp; published history giữ theo yêu cầu kiểm tra lịch cũ, không xóa vì hết mùa mà chưa duyệt.
- Tách retired generations khỏi hot heap nếu tỷ lệ T/active và latency thật cho thấy cần. Phải bảo toàn FK/lineage seed/recovery; đây không phải quick migration.
- Scoped revision theo ngày/shard có thể giảm global contention nhưng là refactor protocol: date-window snapshot token, multi-day ordering, catalog revision, Publish/Daily atomicity phải được thiết kế lại đồng bộ.
- Autovacuum/tuning dựa `pg_stat_user_tables`, WAL/temp/lock stats; không coi mọi growth là bloat rồi VACUUM FULL production.

## 8. Lộ trình và quyết định cuối

| Pha | Phạm vi | Gate qua pha |
|---|---|---|
| A — Inventory & đo | Live/source definitions, query plans, size/lag/locks, retention contracts | Có baseline chính xác; phân biệt gate OFF/ON; không thủ thuật DB ngoài source chưa giải thích |
| B — Bảo vệ/lifecycle | Checksum/immutability, cleanup preview, index theo plan, diff cache | Parity + recovery/receipt retention không regression |
| C — History indexed | Version flight rows/paging, export/restore một authoritative boundary | Snapshot checksum, owner/pair/resources parity và page cost bounded |
| D — Recency/projection | Current recency + affected-scope worker, full reconciliation | Exact generation coverage, stale fail-closed, quarantine/aggregation parity |
| E — Cutover & archival | Hoàn tất caller native, bỏ dual legacy path có kiểm soát; cold storage nếu cần | Nghiệm thu app/auth/runtime/production theo quy trình riêng |

**Có nên giữ hiện tại?** Giữ mô hình native Current State + History tách biệt + reporting projection. Không nên giữ indefinitely hai kiến trúc legacy/native và full-scan history/projection khi tăng 10–100 lần. Tái cấu trúc **có mục tiêu là cần thiết cho mục tiêu scale**, nhưng chưa có bằng chứng buộc phải thay toàn DB ngay hoặc dữ liệu live đang sai.

## 9. Giới hạn và Stop Conditions

- Không query production trong phiên; không khẳng định deployment mới nhất, grants/trigger/job ngoài repo hay distribution production.
- Không có benchmark 10–100×; hai EXPLAIN là representative SQL trên synthetic DB local, không full UI/API capacity test.
- Không thực hiện refresh, replay event, mutation hoặc test suite ghi vào DB trong audit này.
- Repo có dynamic `pg_get_functiondef` preimage capture để giữ hàm legacy khi cutover (`20260929120000...:536–544`). Điều đó làm deployed preimage phụ thuộc môi trường; cần đối chiếu live definitions trước rollout. **Chưa phát hiện bằng chứng một trigger/procedure live ngoài source**, nên không kích hoạt stop condition chỉ vì không truy cập production.
- Nếu inventory live phát hiện procedure/trigger không thể giải thích từ repo, dừng trước khuyến nghị migration cho phần đó và yêu cầu xác nhận nguồn/preimage; không suy diễn tự thêm logic.
- Audit hoàn tất ở file này; mọi thay đổi schema/index/worker ở §7–8 là đề xuất, chưa được thực hiện.

## 10. Đánh giá bổ sung: ảnh hưởng lên Import/Export và các chức năng liên quan

**Phạm vi bổ sung:** ảnh hưởng của đề xuất §7–8, không phải thay đổi đã triển khai. Fact dưới đây đối chiếu source; mức rủi ro và kết quả sau refactor là **[INFERENCE]**. Không chạy import/commit/restore hoặc sửa dữ liệu để đánh giá trong phiên chỉ đọc này.

### 10.1. Các hợp đồng chức năng hiện tại phải giữ

| Chức năng | Hợp đồng quan sát trong source | Boundary không được thay thế |
|---|---|---|
| Import Daily native V2 | Stage theo `affectedDates`; ngày rỗng phải xác nhận; commit kiểm preview hash và scope fingerprint, replace toàn active legs trong các ngày đó; lưu day authority và receipt | Không biến thành upsert từng dòng, không ép Season ID, không xóa các ngày nằm giữa một scope sparse |
| Re-import Daily | Match active hoặc terminal lineage theo leg key + scheduled date; tăng lineage generation; lấy explicit operator overrides từ leg đã match | Không coi mọi field của file cũ là override; không bỏ explicit NULL/0; không chọn tùy ý khi nhiều lineage |
| Import Seasonal native | Stage/commit vào Draft, kiểm epoch/revision/checksum và owner season; giữ metadata nguồn, allocation và reciprocal pairing | Không tự publish hoặc ghi Operations; không đổi merge/replace để tiện lưu trữ |
| Export lịch mùa đang làm việc | Khi Planning bật, lấy Draft snapshot theo epoch/revision; adapter sang FlightRecords, validate selection/pairing rồi canonical rows và Excel | Không lấy active Operations thay Draft; không xuất chỉ page đang hiển thị |
| Export lịch mùa phiên bản đã Publish | RPC nhận `version_id`, normalize flights từ snapshot của version đó | Không lấy latest Draft/Operations; không dùng version tag như định danh thay UUID |
| Export Daily Excel | UI truyền `sortedRows` hiện có sang summary workbook cùng route-country settings | Giữ semantics “visible rows theo bộ lọc”, không âm thầm đổi thành toàn season/toàn DB |
| Restore phiên bản | Normalize snapshot về Draft; có workspace fence và request receipt | Restore Draft không đồng nghĩa rollback Operations; muốn áp dụng phải qua Publish |
| Publish | Chỉ operations eligible trong tương lai; day authority chưa reset được bảo vệ; seed lineage kể cả terminal, shared effective target computation và operational acknowledgement | Không ghi đè ngày Daily đã sở hữu, kể cả ngày zero-flight; không bỏ collision/ack/stale checks |

Nguồn đối chiếu:
- Daily: `app/supabase/migrations/20260928180000_operational_daily_import_v2.sql:101–115,195–221,261–394`; UI xác nhận zero: `app/src/app/(desktop)/daily/page.tsx:1147–1172`.
- Seasonal: `app/supabase/migrations/20260928200000_seasonal_draft_import_v1.sql:120–147,239–306`; Draft export: `app/supabase/migrations/20260928190000_seasonal_planning_v1.sql:716–738`.
- Export UI: `app/src/app/(desktop)/SeasonalSchedulePage.tsx:1235–1298,1317–1354`; Excel writer: `app/src/lib/canonicalSeasonalRows.ts:462–495`; Daily writer call: `app/src/app/(desktop)/daily/page.tsx:863–884`.
- Published export/restore: `app/supabase/migrations/20261008100000_seasonal_version_management_v1.sql:290–350,397–475`.
- Publish eligibility/lineage: `app/supabase/migrations/20261008090000_seasonal_publish_safety_v1.sql:92–164`; override capture/backfill: cùng file, 54–89.

### 10.2. Ma trận tác động của từng nhóm chỉnh sửa

Mức rủi ro thể hiện mức độ có thể làm sai chức năng nếu triển khai không giữ boundary, không phải xác suất lỗi đã đo.

| Đề xuất | Chức năng bị ảnh hưởng | Rủi ro | Điều kiện triển khai an toàn |
|---|---|---|---|
| Thêm index theo plan | Import/Publish bulk write, Daily/history reads | Thấp về semantics, trung bình về write cost | Không thêm UNIQUE làm đổi identity; đo write latency/WAL/locks, không chỉ SELECT nhanh hơn |
| Cleanup preview chưa committed | Import Daily/Seasonal, Publish preview, cancel/status/retry | Trung bình | Phân biệt batch preview và receipt committed; chỉ xóa theo trạng thái, retention và dependency đã kiểm; request đang mở hết hạn phải có lỗi rõ ràng |
| Checksum + immutability | Published export, restore, diff và migration/backfill | Trung bình–cao | Cùng canonical serializer/schema version; backfill và maintenance dùng quy trình rõ; không chặn nhầm Draft mutable hoặc update preview status/receipt |
| Indexed snapshot flights | History viewer/diff, published export/restore; Publish ghi thêm snapshot | Cao | Atomic parent/children/resources; một nguồn authoritative; adapter giữ record IDs và cặp; complete version visibility; kiểm storage và latency Publish |
| Current recency | Import Daily, Publish, chỉnh Pax, Report/Dashboard | Cao | Update entity/day recency cùng transaction; authority precedence không đổi; không thay bằng timestamp; xử lý removal/zero/move và rollback |
| Incremental projection | Report/Dashboard sau Import/Publish/Pax correction | Cao | Dirty cả scope replace, old/new dates và counterpart; generation atomic, worker restart idempotent; stale fail-closed và full reconciliation |
| Archive events/retired legs | Re-import, Publish seed, overrides, retry/audit và conflict checks | Rất cao nếu xóa trực tiếp | Map từng consumer; giữ seed/lineage/authority/receipt trong hot store hoặc chuyển lookup đồng bộ; không archive theo tuổi đơn thuần |
| Scoped revision | Daily/Check-in/Gate window paging, mutation, import/publish concurrency | Rất cao | Migrate tất cả token/caller; lock multi-day có thứ tự; atomic write và coherent page snapshot; triển khai sau, không quick win |
| Bỏ legacy paths/mirror | Export cũ, import cũ, report consumers, rollback | Cao | Inventory flags và callers live trước; parity riêng OFF/ON; hoàn tất native consumers trước khi xóa nguồn cũ |

### 10.3. Import Daily: rủi ro nghiệp vụ lớn nhất nằm ở retention và incremental refresh

**Retention không phải thao tác độc lập với importer.** Daily stage tra terminal rows khi không còn active match (195–221); Publish cũng chọn seed từ tất cả owned generations (105–111). Xóa retired legs có thể:
- Làm dòng re-import bị coi là lineage mới, mất explicit operator overrides hoặc không phát hiện lịch sử nhiều lineage.
- Mất seed mà republish dùng để preserve resource/Pax; FK/lineage dependency cũng phải được kiểm trước archive.
- Làm scope fingerprint khác preview đang mở: fingerprint hiện hash cả active lẫn non-active rows, authority, overrides, counters và windows (101–115). Archive trong lúc preview tồn tại có thể gây `PT409` dù active schedule không đổi. Không được bỏ fingerprint check để che tác động này.

**Incremental projection phải xử lý replacement, không chỉ inserted legs.** Ví dụ ngày D có 10 flights, import lại còn 6: phải resolve lại scope D để 4 flights cũ biến mất khỏi report. Nếu chỉ enqueue IDs mới, current Daily có thể đúng nhưng report vẫn đếm chuyến cũ. Với zero-flight, không có inserted leg để kích hoạt worker; day authority event phải đủ để dirty D.

**Pairing vượt ngày:** commit hiện unlink surviving counterpart ngoài `affectedDates` và ghi event (295–306). Vì vậy dirty scope không được chỉ lấy ngày trong workbook; counterpart ngoài scope cũng có thể thay đổi. Ngày sparse không được mở rộng thành mọi ngày từ min đến max để replace dữ liệu.

**Lost ACK:** import đã committed nhưng client mất response phải status/retry bằng request gốc, trả receipt cũ; projection lag không được biến thành “import chưa thành công” hoặc tự stage một batch mới. Giữ distinction giữa commit thành công và report chưa fresh. Không đổi request idempotency chỉ để thuận tiện cleanup.

### 10.4. Export Excel lịch mùa: tách ba dạng snapshot, không đánh đồng

1. **Draft hiện tại:** nút Export khi Planning ON gọi `getSeasonalDraftExportSnapshotV1` với epoch/revision. Indexed *published* snapshot không tự giảm chi phí export này; muốn page/stream Draft phải thiết kế riêng coherent snapshot token và lấy đủ các page.
2. **Published version:** RPC dùng `version_id` và snapshot flights bất biến. Khi đổi storage phải giữ normalization `seasonal_published_flight_to_draft_json_v1` hoặc semantics tương đương; không đọc current Draft thay cho version cũ.
3. **Legacy khi flag OFF:** UI còn gọi seasonal export snapshot + materialize overlays. Bỏ legacy chỉ sau inventory/rollout; không dùng baseline legacy ghép Daily vào seasonal export để buộc native Planning tiếp tục phụ thuộc Operations.

Các điều kiện bắt buộc:
- Giữ season ownership, `draft_id` → `record_id`, linked counterpart, turnaround/link type/pair anchor và scheduled date qua overnight/mốc ngày vận hành 05:00. Không ghép cặp chỉ bằng flight number + ngày vận hành.
- Export-all lấy đủ flights; export selection giữ đúng identity và quy tắc counterpart hiện tại. Draft thay đổi hoặc chuyển season giữa fetch/download phải bị chặn theo guard hiện có, không trộn hai revision.
- Giữ canonical writer/template: Effective/Discontinue, Mon–Sun, ARR/DEP flight/route/time, aircraft, category, code shares, IntDom và sheet seasonCode. Đổi schema lưu snapshot không phải lý do đổi các header/format này.
- Không bỏ duplicate/pairing validation hoặc round-trip validation để khiến file tải được. Lỗi “missing counterpart” phải giải quyết ở data/adapter/pair identity, không suppress validator.
- NULL/0 Pax và resources vẫn phải giữ trong snapshot/API/restore. **Không suy ra template Seasonal Excel xuất toàn bộ allocation:** writer hiện tại 462–495 không có cột Pax/gate/counters/windows. Nghiệm thu round-trip Excel so trường mà template thực sự biểu diễn; nghiệm thu API snapshot/restore riêng cho allocation. Không yêu cầu Excel tái tạo metadata nội bộ mà template không chứa.
- Checksum kiểm trên canonical snapshot gốc trước normalize/export, không hash lại FlightRecords hay bytes Excel rồi so với checksum publish. Cần schema/serialization version; nếu không, bản hợp lệ có thể bị từ chối sau refactor.

**Hiệu năng:** indexed storage chỉ giảm paging History nếu query seek thật. Export toàn mùa và restore vẫn cần đọc toàn N, canonical grouping/validation và có thể materialize workbook trong client. Không cam kết full export O(page size), và Publish có thêm write amplification nếu giữ JSON artifact lẫn relational rows.

### 10.5. Import Seasonal, Restore/Publish và Daily/Check-in/Gate

- Import Draft hiện giữ allocations bằng before-state merge rồi thay các schedule/source fields, và commit kiểm pairing reciprocal. Refactor storage/history không được đổi precedence, hồi sinh deleted row, merge/replace hoặc provenance dùng cho matching. Dọn staging/source rows phải kiểm consumer/FK, không coi toàn bộ là temporary.
- Restore vẫn là thao tác Draft. Snapshot rows mới phải có đầy đủ cả allocation, source metadata và pairing để normalize/restore, không chỉ những cột hiện trong Excel. Operations/report không đổi cho tới Publish sau restore.
- Publish phải tạo version/snapshot/diff/receipt và áp dụng Operations trong cùng boundary transaction hiện có. Không cho History thấy version hoàn chỉnh trước khi children/resources ghi xong. Giữ no-op semantics, acknowledgement và Pax overrides kể cả explicit 0/NULL.
- Daily/Check-in/Gate đọc current operational data; reporting projection async không nên nằm trong critical read path của các màn hình này. Giữ snapshot token nhất quán giữa pages và resources; scoped revision đòi đổi protocol đồng bộ, không chỉ sửa singleton DB.
- Report/Dashboard có thể phản ánh chậm hơn commit do worker. Không trả “fresh” khi thiếu affected scope; dashboard publication và pinned report export phải giữ generation/snapshot riêng, không tự trỏ sang live current mới hơn.

### 10.6. Acceptance matrix bắt buộc trước khi sửa/rollout

Đây là **kế hoạch nghiệm thu**, không kết quả test đã chạy ở phần bổ sung này. Dùng baseline trước/sau trên DB local cô lập; normalize field ordering khi phù hợp, không loại các field nghiệp vụ/authority để ép parity. Kiểm SQL/API và thực sự mở UI/xuất rồi parse workbook, không chỉ kiểm source hoặc compile.

| Ca nghiệm thu | Bằng chứng cần thu |
|---|---|
| Daily import ngoài mọi Season, sparse D1/D3 | Hai ngày đúng bị replace; D2 và Draft các mùa không đổi; counters/windows/pair đọc đúng |
| Re-import cùng lineage sau operator override/clear | Tạo generation kế tiếp, giữ explicit overrides/NULL/0; raw AMS resource không tự thành override |
| Zero-flight | Chỉ cho commit khi xác nhận; Daily và report không còn flights ngày đó; Publish sau đó không lấp lại ngày chưa reset authority |
| Overnight/05:00, replace một nửa pair | Counterpart ngoài scope không còn dangling link; scheduled/operational date đúng; dirty report bao gồm scope thay đổi |
| Edit hoặc Publish sau stage Daily | Commit stale từ chối nguyên transaction; stage mới thấy đúng dữ liệu; thay unrelated day theo contract hiện tại không phá scope |
| Commit thành công, mất ACK, cleanup/worker restart | Status/retry trả cùng receipt; không batch/version/event trùng; report cuối cùng đúng generation |
| Import Seasonal merge/replace và deleted/manual row | Matching/provenance/allocation/pairing giữ semantics; Operations và projection không bị Draft import ghi trực tiếp |
| Export Draft all/selected trên nhiều pages | Workbook đủ phạm vi đã yêu cầu, header/sheet/dates/ARR–DEP/weekly grouping giữ format; parser round-trip giữ trường biểu diễn |
| Đổi Draft hoặc season khi đang export | Không download workbook từ mixed/stale context; thông báo lỗi rõ, fetch mới dùng đúng season |
| Export version cũ sau import/republish/operational edit | Nội dung schedule đúng version đã chọn; không lẫn dữ liệu mới; checksum snapshot hợp lệ |
| Restore version cũ rồi Publish | Restore giữ source/pair/allocation, không đổi Operations; Publish preview/commit tôn trọng Daily authority và operator Pax |
| Partial snapshot write hoặc checksum sai | Không xuất/restore partial hoặc corrupted version; không để write một nửa transaction; lỗi không tự fallback latest |
| Incremental report với removal/move qua năm/quarantine | Rows, Pax, aggregates, coverage/quarantine và old/new years parity với full reconciliation; chỉ fresh khi scope đã cover |
| Archive khi preview/re-import còn consumer | Receipt/lineage/override và stale detection vẫn đúng; nếu chưa có lookup replacement thì không archive các rows đó |
| OFF/ON và quyền read/write | UI/API đúng reader authority, RLS/permission không yếu đi; rollback không mất native writes |

Suite hiện có liên quan, đã tìm trong source nhưng **không chạy lại trong bổ sung chỉ đọc**:
- `app/supabase/tests/seasonal_operational_separation_m5_daily_pglite.mjs`: replace/rebase/zero/lineage/stale/overnight.
- `app/supabase/tests/seasonal_operational_separation_m6_import_pglite.mjs`: Draft import merge/replace, allocations, receipt và isolation.
- `app/supabase/tests/seasonal_operational_separation_m6_planning_pglite.mjs`: Draft export fence, pairing, Operations isolation.
- `app/supabase/tests/seasonal_operational_daily_authority_pglite.mjs`: Daily authority/Pax và canonical quarantine.
- `app/supabase/tests/seasonal_operational_separation_m3_projection_pglite.mjs`: projection freshness/source-read race.
- `app/supabase/tests/seasonal_operational_separation_m10_cutover_pglite.mjs`: cutover/fencing, stale report và dashboard publication.

Không coi các suite milestone dùng preimage/rollback như bằng chứng tự động cho latest production chain; nghiệm thu forward migrations đầy đủ và surface UI trên runtime mục tiêu là gate riêng.

### 10.7. Điều chỉnh thứ tự thực hiện sau đánh giá chức năng

1. **Inventory và baseline chức năng trước:** chốt flags/callers/receipts live; lấy workbook export và normalized API snapshot làm chuẩn theo từng boundary.
2. **Index/quan sát trước:** ít rủi ro đổi nghiệp vụ; đo cả bulk import/Publish writes. Cleanup chỉ preview expired theo dependency/receipt policy đã kiểm.
3. **Snapshot indexed + checksum:** giữ adapter/template và một authoritative source; nghiệm thu historical export/restore trước, không ghép chung với đổi protocol Daily.
4. **Current recency + incremental projection:** triển khai shadow/full reconciliation parity; các producer Import Daily/Publish/Pax cùng đáp ứng authority/generation contract.
5. **Retention retired legs/events, scoped revision và bỏ legacy sau cùng:** chỉ thực hiện khi dependency map, lookup thay thế và rollback gate đầy đủ.

**Quyết định:** giữ nguyên nghiệp vụ và template Import/Export. Không đưa “archive hết lịch sử cũ”, “replace chỉ các leg mới”, “Export Seasonal từ Operations” hoặc “đổi revision protocol tại DB nhưng giữ client cũ” vào quick wins. Các đề xuất này có thể làm sai chức năng dù query nhanh hơn.

## 11. Triển khai có gate — 09/10/2026

Phần này ghi nhận đợt triển khai sau audit chỉ đọc ở §1–10. Thay đổi nằm trong checkout và đã được chạy trên DB thử nghiệm cô lập; **không xác nhận hoặc thay đổi deployment production**.

### 11.1. Phạm vi đã triển khai

| Migration / runtime | Thay đổi | Boundary giữ nguyên |
|---|---|---|
| `20261009090000_seasonal_snapshot_integrity_indexed_v1.sql` và rollback | Relational snapshot flights; seek paging History; metadata active count; persistent cache arbitrary comparison, kể cả diff rỗng; checksum ở insert/derive/export/restore; UPDATE/DELETE guards và statement TRUNCATE guards | JSON published snapshot vẫn là recovery authority; Draft/Operations không trở thành nguồn export phiên bản cũ; giữ adapter và template |
| `20261009100000_operational_incremental_projection_v1.sql` và rollback | Entity/day recency lookup cùng transaction; durable dirty scopes gồm old/new dates, counterpart, authority, quarantine và backfill links; incremental resolve toàn candidates trong scope; periodic full reconciliation | Identity, day authority, missing/tied recency quarantine, explicit Pax NULL/0 và stale fail-closed |
| `20261009110000_schedule_preview_lifecycle_v1.sql` và rollback | Maintenance RPC reclaim child staging của preview expired chưa committed; tối đa 100 parent/subsystem/call; khóa parent `SKIP LOCKED` | Giữ parent/request/hash/status và toàn committed children/receipt/history/lineage; không tự bật job cleanup |
| `deploy/traffic-report/seasonal-operational-projection-runner` | Worker kiểm reconcile-due riêng, kể cả projection đang fresh; flag SQL trả text `true/false`; lỗi query không bị chuyển thành “không cần reconcile” | Giữ status RPC đúng 9 cột; single-flight, bounded retry, notification listener và timer fallback |

Projection lấy shared lock singleton Operational revision khi refresh và claim dirty scopes/generation atomically. Synthetic mid-refresh mutation phải để lại trạng thái stale rồi catch up; smoke PostgreSQL hai connection chứng minh refresh bị chặn khi writer giữ revision lock. Không dùng watermark lớn nhất như bằng chứng mọi sequence đã commit.

Rollback projection phục hồi function definitions/owner và quyền execute từ captured preimages, không dán một phiên bản SQL giả định. Re-apply giữ preimage ban đầu và không capture overload boolean do chính migration mới tạo. Các suite milestone M5/M6/M7/M10 đã điều chỉnh rollback dependency trước khi thử lại migration cũ; chúng không thay thế nghiệm thu chuỗi forward mới.

### 11.2. Quyết định gate

| Hạng mục | Quyết định trong đợt này | Điều kiện mở gate tiếp theo |
|---|---|---|
| Index | Chỉ thêm index phục vụ snapshot seek/cache, dirty date lookup và expired-preview selection; không thêm UNIQUE cho business flight identity hoặc index toàn event chỉ vì suy đoán | EXPLAIN/latency/WAL/bulk-write trên distribution runtime mục tiêu; chưa có benchmark production để khẳng định cải thiện bao nhiêu |
| Cleanup preview | Có RPC privileged, chưa cài scheduler; giữ cả parent payload vì request/status/retry còn dùng | Chọn lịch bảo trì và đo reclaimed bytes; không gọi đây là cơ chế dọn hết JSON/TOAST preview |
| Receipt/history/event/retired-leg retention | Không xóa hoặc archive | Chốt retention horizon và map consumers lineage/overrides/conflict/undo/retry; archive cần lookup thay thế và parity |
| Scoped revision | Không đổi singleton revision hoặc window token | Đo contention; thiết kế/migrate đồng bộ multi-day locks, paging token và catalog revision; không sửa DB riêng rồi giữ client cũ |
| Legacy/canonical mirror cutover | Giữ existing OFF/ON gate và mirror contract; không bật production, không xóa callers legacy | Inventory live flags/functions/writers, replay/high-water parity, app/auth/runtime acceptance và data-safe reversal |

Không có clean cutover giả bằng alias API cũ: vấn đề chữ ký Publish trong milestone fixture được sửa ở thứ tự rollback, không thêm overload tương thích vào production contract.

### 11.3. Bằng chứng nghiệm thu

Các lệnh dưới đây chạy từ `app/`; kết quả PASS trong đợt triển khai này:

| Kiểm chứng | Kết quả quan sát |
|---|---|
| `npm run test:seasonal-operational-m0` | Baseline giữ nguyên: 12 effective legs, 8 canonical legs, 1 quarantine; export W26=8/M26=3, window=5 |
| `npm run test:seasonal-operational-m5-daily` | Scope không cần mùa, zero/sparse, receipts, stale preimages, overrides, Pax NULL/0, lineage/pairing và legacy isolation |
| `npm run test:seasonal-operational-m6-planning` | Draft-only mutation/export, revision/conflict/receipt, matching/ambiguity, preview staleness và version-pinned export |
| `npm run test:seasonal-operational-m6-import` | Merge/replace, allocation/Pax, time/presence precedence, source/pairing, cancel/expiry và Operations isolation |
| `npm run test:seasonal-operational-m7-publish` | Publish lifecycle, stale preview, acknowledgement/overrides, exact receipt và immutable history |
| `npm run test:seasonal-operational-m10-cutover` | Gate OFF/ON, stale refusal/report, legacy writer fence, dashboard/KPI consumers, reversal và rollback |
| `node supabase/tests/seasonal_version_management_pglite.mjs` | History/export/diff/restore/republish và migration rollback/reapply |
| `node supabase/tests/seasonal_snapshot_integrity_indexed_pglite.mjs` | Indexed paging/pair/NULL/0, corruption rejection, immutability DELETE/UPDATE/TRUNCATE, comparison cache và restore receipt |
| `node supabase/tests/seasonal_operational_incremental_projection_pglite.mjs` | Replace/removal/zero, move/year/counterpart, quarantine, incremental/full parity, race fail-closed, gate OFF/ON, reconcile và repeated-apply rollback |
| `node supabase/tests/schedule_preview_lifecycle_pglite.mjs` | Expired children reclaimed; fresh/committed giữ nguyên; lost-ACK replay giữ receipt; stale commit/permissions và rollback |
| `npm run test:operational-projection-runner` | 9 ca PASS: fresh/reconcile, stale catch-up, revision race, retry exhaustion, failed refresh/status/reconcile, single-flight và listener reconnect |

Smoke throwaway trên **PostgreSQL 17.11 thật** dùng chính shared migration harness, schema và 71 forward migrations được harness chọn. Harness vẫn giữ exclusion có sẵn `20260829190000_public_traffic_canonical_cutover.sql` vì baseline view khác production-patched view; đây không phải chạy lại toàn lịch sử production không có ngoại lệ.

Smoke đã chạy actual `seasonalDraftExportSnapshotToFlightRecords`, canonical Excel writer và parser: Import Seasonal → Publish → export Draft và published version → đọc workbook 25 cột/sheet seasonCode → so leg/date/flight/route/time mà template biểu diễn → re-import. Kiểm riêng API snapshot giữ identity/pair/resources; không buộc Excel mang lifecycle metadata hoặc Pax/counters mà template không có.

Smoke còn thực hiện Daily replacement/receipt replay, Pax 0, zero-flight, export version cũ sau đổi Operations, restore chỉ vào Draft, incremental/full canonical parity và hai-connection refresh lock. Ba statement TRUNCATE guards và reconcile flag text cũng được kiểm trực tiếp trên PostgreSQL. Database có tên ngẫu nhiên được script tạo riêng và drop trong `finally`; script/modules transpile tạm được dọn sau nghiệm thu.

### 11.4. Giới hạn rollout

- Chưa deploy migration hoặc worker/service/timer tới production; không bật feature gate hoặc chạy cleanup trên dữ liệu người dùng.
- Không có UI thay đổi trong đợt này, không tuyên bố đã kiểm lại giao diện trình duyệt/desktop hoặc tải workbook qua UI. Smoke đã thực thi exporter/parser thực và API SQL thật.
- Worker suite chạy shell runner thật với external host adapters thay thế; không chứng minh Docker/systemd timer scheduling hoặc PostgreSQL NOTIFY end-to-end trên máy production.
- Chưa có load test 10–100×, dữ liệu production, đo publish write amplification hoặc kế hoạch retention được duyệt. Full export/restore vẫn O(N); relational snapshot/cache tăng storage, không phải nén history.
- Rollback migration và rollback dữ liệu nghiệp vụ là hai việc khác nhau. Sau native writes, reader reversal phải qua gate kiểm dữ liệu; không dùng file rollback để hứa khôi phục lịch vận hành cũ.

