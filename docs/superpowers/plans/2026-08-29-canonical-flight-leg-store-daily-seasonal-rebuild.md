# Kế hoạch hợp nhất Daily Schedule và Seasonal vào một nguồn Flight Leg chuẩn

**Ngày lập:** 2026-08-29

**Trạng thái:** Kế hoạch thực hiện — chưa sửa code, chưa thay đổi schema, chưa ghi production

**Phạm vi:** Daily Schedule import, chỉnh sửa/xóa flight leg hiện hành, Seasonal Merge/Full Replace/rebuild, các consumer Daily/Gate/Check-in/reporting/realtime

**Nguồn leg chuẩn mục tiêu:** `public.season_flight_records`

---

## 1. Mục tiêu

Sau khi hoàn tất kế hoạch này, hệ thống phải đáp ứng đồng thời:

1. Mọi flight leg đang có hiệu lực, dù đến từ Seasonal, Daily hay thao tác thêm thủ công, đều nằm trong `season_flight_records`.
2. Daily import thay thế toàn bộ lịch trong phạm vi Ops Date đã xác nhận bằng một transaction:
   - leg cũ được giữ làm lịch sử nhưng chuyển sang `action='deleted'` và `status='deleted'`;
   - leg Daily mới được insert vào cùng bảng với provenance đầy đủ;
   - nếu bất kỳ bước nào lỗi thì toàn bộ trạng thái trước import được giữ nguyên.
3. Seasonal rebuild chỉ quản lý baseline Seasonal và không được xóa, ghi đè hoặc làm sống lại Daily authority đã commit.
4. Chỉnh sửa/xóa flight leg hiện hành tiếp tục hoạt động với leg Seasonal, Daily và Manual theo cùng một contract.
5. Daily, Gate, Check-in, Seasonal workspace và reporting đọc cùng một effective view; không consumer nào tự chọn một snapshot lịch bay khác.
6. Có thể đối soát trước/sau theo Ops Date, identity, source batch, Pax, audit receipt và data version.

### Không thuộc phạm vi tự động của kế hoạch này

- Không chạy migration hoặc import thật vào production khi chưa có phê duyệt riêng.
- Không hard-delete lịch sử leg đã bị thay thế.
- Không loại bỏ bảng staging/audit cần cho preview, recovery và truy vết.
- Không gộp mọi bảng vật lý thành một bảng. “Một database” trong kế hoạch này nghĩa là **một canonical live leg store**, không phải loại bỏ metadata, audit, draft hay projection phục vụ kỹ thuật.

---

## 2. Quyết định kiến trúc thay thế kế hoạch Daily V1 cũ

Kế hoạch này **thay thế** quyết định “Canonical Daily snapshot riêng + active-day pointer” trong:

- `docs/superpowers/plans/2026-08-28-daily-schedule-dual-format-atomic-import.md`, mục 2C;
- các chính sách 3.10–3.13 có phụ thuộc Daily snapshot riêng;
- target flow ở mục 5 có bước cập nhật `daily_schedule_active_days`;
- effective read boundary và server commit ở mục 7;
- phần commit/resolver/cutover của Task 7, 8, 10, 11 và 12.

Các phần sau của kế hoạch cũ **vẫn giữ nguyên** và được tái sử dụng:

- hỗ trợ ngang nhau cho `.xls` và `.xlsx`;
- mapping 43 trường theo vị trí, không phụ thuộc tiêu đề;
- fixture/parser/date/resource normalization;
- Ops Date theo `Asia/Ho_Chi_Minh`, ngưỡng 05:00;
- `Stand20A -> 20A`, `G1 -> 1`, bare `G -> null`, `C30 -> 30`, `M1` giữ nguyên;
- strict validation, preview, checksum, expected version, audit và file-level atomicity.

Quyết định mới:

```text
Workbook .xls/.xlsx
  -> parse + normalize + validate
  -> durable staging và preview
  -> một transaction commit
       mark old canonical legs deleted
       insert new Daily legs vào season_flight_records
       rebase overlay hợp lệ
       ghi replacement scope + audit + data version
  -> canonical effective view
  -> Daily / Gate / Check-in / Seasonal / Reporting
```

`daily_schedule_import_batch_legs` được giữ làm staging/audit. Nó không còn là live schedule.

`daily_schedule_active_days` được giữ tạm để rollback/đối chiếu trong giai đoạn chuyển đổi, sau đó decommission khi mọi consumer đã cắt sang canonical view.

---

## 3. Bằng chứng hiện trạng và gap cần xử lý

### 3.1 Canonical base và overlay hiện hành

- `app/supabase/schema.sql` định nghĩa `season_flight_records` với leg A/D, schedule, route, Pax/resource, `action`, `source_kind`, `status` và `source_import_batch_id`.
- Chỉnh sửa/xóa từ UI hiện không sửa trực tiếp base; thay đổi được ghi vào `season_modifications` qua `upsert_season_modification_from_json`.
- Leg thêm thủ công đang nằm ở `season_modification_added_legs`, tức hiện tại vẫn có một kho leg thứ hai.
- `app/src/lib/effectiveSeasonalLegs.ts` đã hiểu cả deletion ở base và deletion overlay, nhưng các SQL consumer chưa dùng cùng một predicate.

### 3.2 Inconsistency của deletion

- Một số client coi leg bị xóa khi `record.action='deleted'`, `record.status='deleted'` hoặc modification có `action='deleted'`.
- `reporting.effective_flight_operations` hiện lọc `status='deleted'` và modification deleted, nhưng không lọc nhất quán `record.action='deleted'`.
- Public traffic-report projection cũng không được phép giả định chỉ một trong hai cột.

Vì vậy, giai đoạn chuyển đổi phải:

1. ghi đồng thời `action='deleted'` và `status='deleted'` khi Daily thay thế leg cũ;
2. chuẩn hóa mọi consumer về một hàm/predicate canonical;
3. thêm check/diagnostic để phát hiện trạng thái mâu thuẫn.

### 3.3 Incompatibility với Seasonal rebuild

- `source_kind` hiện chỉ cho phép `imported|added`.
- Nhiều RPC Seasonal chỉ quản lý `source_kind='imported'`.
- Nếu Daily leg mới tiếp tục mang `source_kind='imported'`, Seasonal rebuild có thể cập nhật, xóa hoặc làm sống lại sai leg.
- Unique index active occurrence hiện chỉ bảo vệ imported rows, chưa bảo vệ uniqueness xuyên Seasonal/Daily/Manual.

### 3.4 Reporting và Pax

- Daily live batch có thể chứa Pax đúng nhưng reporting vẫn đọc baseline/projection khác.
- Việc “commit Daily thành công” chưa đủ nếu report không đọc cùng canonical effective view hoặc materialized projection chưa refresh đúng version.
- Kế hoạch phải đối soát riêng raw Daily Pax, canonical base Pax, effective Pax sau overlay deletion và report Pax.

---

## 4. Invariant nghiệp vụ bắt buộc

### 4.1 Một nguồn leg chuẩn

- `season_flight_records` là bảng duy nhất chứa leg đang có hiệu lực.
- `source_kind` mục tiêu: `seasonal | daily | manual`.
- Staging/import batch lưu payload và bằng chứng, không tham gia live resolver sau cutover.
- `season_modifications` tiếp tục là delta/overlay trong pha đầu; nó không phải một bản sao leg độc lập.
- `season_modification_added_legs` phải được migrate sang `season_flight_records(source_kind='manual')` trước khi tuyên bố hoàn tất “một canonical leg store”.

### 4.2 Trạng thái leg

Canonical predicate:

```sql
status = 'active'
and action is distinct from 'deleted'
```

Quy ước ghi:

| Trường hợp | `source_kind` | `status` | `action` |
|---|---|---|---|
| Seasonal đang hiệu lực | `seasonal` | `active` | `null` hoặc `modified` theo contract đã khóa |
| Daily mới commit | `daily` | `active` | `null` |
| Leg thêm thủ công | `manual` | `active` | `added` |
| Leg bị Daily thay thế | giữ nguyên nguồn cũ | `deleted` | `deleted` |
| Leg bị xóa qua overlay | base không đổi trong pha đầu | effective deleted qua `season_modifications` |

Không hard-delete leg cũ trong luồng import/rebuild thông thường.

### 4.3 Identity và uniqueness

- Mỗi leg phải có canonical occurrence identity ổn định theo season, Ops Date, side, airline/flight, route và scheduled time theo contract đã kiểm thử.
- Full identity dùng để chặn duplicate active leg.
- Loose identity chỉ dùng để đề xuất rebase overlay khi match duy nhất; không được “first row wins”.
- Unique constraint/index phải áp dụng cho mọi source active, không chỉ Seasonal.
- Nếu file có duplicate/collision, commit bị chặn trước khi xóa dữ liệu cũ.
- Nếu schedule/route thay đổi làm full key thay đổi, đó là leg mới; chỉ được rebase overlay qua rule explicit và match duy nhất.

### 4.4 Ops Date và phạm vi thay thế

- Parse wall-clock tại `Asia/Ho_Chi_Minh`; ngưỡng Ops Date là 05:00.
- Qua nửa đêm nhưng trước 05:00 thuộc Ops Date trước.
- Phạm vi mặc định là `[min Ops Date, max Ops Date]` của các leg hợp lệ.
- Dòng lỗi không được bỏ qua để tiếp tục commit; toàn batch invalid.
- Ngày trống nằm giữa min/max là `coverage-gap`, chỉ được thay thế thành zero-flight day khi operator xác nhận rõ trong preview.
- Tên file chỉ là hint đối chiếu. Không dùng tên file làm nguồn duy nhất để xóa dữ liệu.
- Leading/trailing zero-flight day không thể suy chắc chắn chỉ từ row; cần explicit affected-days từ operator hoặc metadata đáng tin cậy và phải hiện trong preview.

### 4.5 Pax và resource authority

- Flight identity, Ops Date, schedule, route, aircraft, code share và Pax của leg mới lấy từ Daily file đã normalize.
- Pax giữ phân biệt `null` với `0`; không ép ô trống thành 0.
- Resource trống tuân theo policy đã khóa:
  - record mới nhận `null`;
  - overlay vận hành đã commit có thể được rebase khi match duy nhất;
  - không silent merge giá trị cũ vào dữ liệu nguồn mà không hiển thị preview.
- Stand là text; Gate/Carousel là integer hợp lệ; Counter là token text.

### 4.6 Atomicity và concurrency

- Stage/preview không được thay đổi live leg.
- Một file nhiều season phải commit tất cả hoặc rollback tất cả.
- Daily commit và Seasonal commit dùng cùng lock namespace; ưu tiên season-level transaction advisory lock để đúng trước khi tối ưu range lock.
- Commit phải kiểm tra `expected_data_version`, canonical payload hash và preview hash sau khi đã lấy lock.
- Unknown network outcome được resolve bằng `request_id`/status/receipt; client không tự apply optimistic arrays.
- Draft/pending sync trên season đích chặn commit cho đến khi được xử lý rõ ràng.

---

## 5. Data model mục tiêu

### 5.1 Mở rộng `season_flight_records`

Migration dự kiến: `app/supabase/migrations/<next_timestamp>_canonical_flight_leg_store.sql`.

Thay đổi cần thiết:

- mở rộng `source_kind` thành `seasonal|daily|manual`;
- backfill `imported -> seasonal`, `added -> manual` theo rule đã kiểm chứng;
- thêm/chuẩn hóa `ops_date` nếu hiện tại chưa có cột canonical đủ tin cậy;
- thêm provenance:
  - `source_batch_id` hoặc tái sử dụng có kiểm soát `source_import_batch_id`;
  - `source_file_hash`/liên kết batch thay vì lặp raw metadata;
  - `superseded_by_batch_id`;
  - `supersedes_record_id` cho trace one-to-one khi có match duy nhất;
  - `deletion_reason` với giá trị như `daily_replacement`, `seasonal_rebuild`, `manual_delete`;
  - timestamps/actor theo audit policy hiện hành;
- chuyển `stand` sang text xuyên các bảng/view/type liên quan;
- thay unique index chỉ dành cho imported bằng unique active occurrence xuyên mọi source.

Không drop constraint/index cũ trước khi dữ liệu đã backfill và new constraint đã validate.

### 5.2 Replacement scope không chứa flight leg

Tạo metadata table, ví dụ `schedule_replacement_scopes`:

| Field | Mục đích |
|---|---|
| `season_id`, `ops_date` | partition được Daily nắm quyền |
| `authority_source` | hiện là `daily` |
| `source_batch_id` | batch đã commit |
| `expected_leg_count` | hỗ trợ zero-flight day và reconciliation |
| `canonical_checksum` | phát hiện drift |
| `committed_at`, `committed_by` | audit |
| `data_version` | stale/concurrency guard |

Bảng này không phải kho lịch bay. Nó cần thiết để Seasonal rebuild biết rằng một ngày Daily authority với `0` leg vẫn không được tái sinh baseline.

### 5.3 Canonical effective view

Tạo một read boundary, tên đề xuất `reporting.canonical_effective_flight_legs`:

1. lấy active base từ `season_flight_records` bằng canonical predicate;
2. áp dụng `season_modifications` committed;
3. loại deleted overlay;
4. sau migration không còn union `season_modification_added_legs`;
5. xuất đầy đủ provenance, effective fields, source batch, Ops Date và data version.

Mọi live consumer phải đọc view/RPC chung này. Materialized view vẫn được phép tồn tại để tối ưu report, nhưng chỉ là projection từ canonical effective view và phải mang source watermark/version.

### 5.4 Audit và receipt

Receipt của Daily commit tối thiểu có:

- `request_id`, `batch_id`, actor, file hash, payload hash, policy version;
- season và affected Ops Dates;
- count before, soft-deleted, inserted, active after, effective after;
- Pax ARR/DEP/total trước và sau;
- số overlay rebased, skipped, ambiguous, deleted;
- old/new data version;
- canonical checksum theo ngày;
- trạng thái projection refresh/realtime event.

---

## 6. Target flow chi tiết

### 6.1 Daily stage và preview

```text
đọc workbook raw cells
  -> nhận diện vùng bảng
  -> map 43 field theo vị trí
  -> normalize date/resource/Pax
  -> tạo ARR/DEP atomic legs
  -> validate required fields + duplicate + collisions
  -> derive Ops Date + affected range/days
  -> đối chiếu canonical live legs và overlays
  -> tính before/after/Pax/rebase plan/checksum
  -> lưu staging
  -> trả preview bất biến gắn expected versions
```

Preview phải hiển thị tối thiểu:

- từng season, `date_from`, `date_to`, danh sách ngày thực sự bị ảnh hưởng;
- ngày có leg, coverage gap, explicit zero-flight day;
- counts cũ/mới theo ngày và A/D;
- Pax cũ/mới theo ngày và A/D;
- duplicate/invalid row với sheet/row/cell;
- số Seasonal/Daily/Manual leg sẽ bị supersede;
- overlay sẽ rebase, không match hoặc ambiguous;
- typed confirmation cho destructive range và ngày zero-flight.

### 6.2 Daily atomic commit

Trong **một database transaction**:

1. Resolve idempotency `request_id`; receipt committed trả lại kết quả cũ.
2. Lock tất cả season theo thứ tự ổn định bằng namespace dùng chung Daily/Seasonal.
3. Re-read version, draft/pending state, batch state, payload hash và preview hash.
4. Re-run duplicate/identity/affected-scope checks ở server.
5. Capture preimage/checksum phục vụ audit và rollback có kiểm soát.
6. Với mọi canonical active leg trong affected scope:
   - set `status='deleted'`;
   - set `action='deleted'`;
   - set `deletion_reason='daily_replacement'`;
   - set `superseded_by_batch_id=<batch>`.
7. Insert toàn bộ staged Daily leg vào `season_flight_records` với `source_kind='daily'`, record ID mới và provenance.
8. Rebase committed operational overlays chỉ khi rule cho phép và match duy nhất:
   - schedule/route/identity/Pax lấy từ file;
   - Gate/Stand/Counter/Check-in operational override được chuyển sang record mới khi hợp lệ;
   - deleted overlay duy trì deletion trên match duy nhất;
   - ambiguous/no-match làm commit fail hoặc được operator xử lý trước, không silent drop.
9. Upsert `schedule_replacement_scopes`, bao gồm ngày có `expected_leg_count=0` đã xác nhận.
10. Verify active count, effective count, uniqueness, Pax và checksum ngay trong transaction.
11. Ghi audit, receipt, tăng `data_version` và enqueue một canonical schedule event.
12. Commit.

Bất kỳ exception nào từ bước 1–11 phải rollback cả soft delete, insert, overlay rebase, scope, audit và version.

### 6.3 Chỉnh sửa/xóa flight leg hiện hành

Pha tương thích đầu tiên giữ mô hình overlay:

- Edit Seasonal/Daily/Manual leg đều gọi cùng save RPC và dùng canonical `record_id`.
- Delete UI tạo/ cập nhật `season_modifications(action='deleted')`; base vẫn giữ provenance.
- Daily replacement xóa base cũ bằng cả `status/action='deleted'`, khác với user overlay delete nhưng cho cùng effective kết quả.
- Save RPC phải từ chối sửa leg base đã superseded/deleted hoặc stale version.
- Khi Daily replacement tạo record ID mới, overlay được rebase trong chính transaction hoặc commit bị chặn.

Sau khi ổn định mới đánh giá pha 2 có nên materialize modification vào canonical base. Không đưa việc đó vào critical path của lần sửa này.

### 6.4 Seasonal Merge/Full Replace/rebuild

Seasonal commit phải được sửa theo các rule:

- chỉ quản lý rows `source_kind='seasonal'`;
- dùng cùng season lock và `data_version` với Daily commit;
- không update/delete rows `source_kind in ('daily','manual')`;
- trước khi insert Seasonal leg, kiểm tra `schedule_replacement_scopes`:
  - nếu Ops Date có Daily authority thì không activate Seasonal baseline cho ngày đó;
  - kể cả khi Daily scope có `expected_leg_count=0`, không được tái sinh flight;
- Full Replace chỉ soft-delete Seasonal rows thuộc phạm vi Seasonal được xác nhận;
- deleted overlay terminal guard tiếp tục được áp dụng;
- chỉ một repair/reset flow có permission và preview riêng mới được gỡ Daily authority.

### 6.5 Read/report/realtime

- Daily page, Detailed/Seasonal workspace, Gate, Check-in và dashboard đọc canonical effective contract.
- `reporting.effective_flight_operations` được thay bằng hoặc delegate sang canonical effective view.
- Public traffic report materialized view refresh từ đúng canonical source version.
- Commit event mang season, affected Ops Dates, data version, counts/checksum; client invalidate theo scope.
- Report phải phân biệt “projection chưa refresh” với “không có dữ liệu”.

---

## 7. Kế hoạch implementation theo task

### Task 0 — Khóa contract và lập inventory consumer

**Đọc/đối chiếu:**

- `app/supabase/schema.sql`
- `app/supabase/migrations/**`
- `app/src/lib/effectiveSeasonalLegs.ts`
- `app/src/lib/dailySchedule.ts`
- `app/src/app/daily/page.tsx`
- `app/src/app/detailed/EditModal.tsx`
- các RPC import/rebuild/reporting và sibling public traffic-report migration.

**Thực hiện:**

- [ ] Lập bảng tất cả nơi đọc/ghi `season_flight_records`, `season_modifications`, `season_modification_added_legs`, Daily batch legs và active-day pointer.
- [ ] Phân loại authoritative write, staging/audit, overlay, projection và legacy read.
- [ ] Khóa thuật ngữ `seasonal|daily|manual`, active predicate, Ops Date và identity.
- [ ] Chụp schema/RPC/view/index/row-count baseline trước migration.

**Checkpoint:** Không còn consumer chưa được phân loại; chưa thay đổi runtime.

### Task 1 — Viết characterization tests trước khi sửa

**Create/modify dự kiến:**

- parser fixtures/tests trong module Daily import hiện hành;
- `app/supabase/tests/canonical_flight_leg_store_characterization.sql`;
- test contract cho reporting/public traffic report.

**Test bắt buộc:**

- [ ] Edit/delete một Seasonal leg qua save RPC hiện hành.
- [ ] Deleted overlay không bị Seasonal Merge/Full Replace làm sống lại.
- [ ] `record.action='deleted'` và `record.status='deleted'` được từng consumer xử lý ra sao.
- [ ] Manual-added leg xuất hiện ở từng workspace/report.
- [ ] Pax nguồn, effective và report hiện tại được ghi lại riêng.

**Checkpoint:** Có bằng chứng đỏ/xanh mô tả chính xác gap trước migration.

### Task 2 — Giữ và hoàn thiện dual-format canonical parser

**Tái sử dụng từ kế hoạch 2026-08-28:** Task 1–5.

- [ ] Fixture thật đã ẩn dữ liệu nhạy cảm hoặc synthetic tương đương cho `OperationalTurns (16).xls` và `LB_20260823_20260827.xlsx`.
- [ ] Header có thể khác, mapping vẫn theo 43 vị trí.
- [ ] Không partial parse; row lỗi chặn batch.
- [ ] Test Excel serial date, date1904, text date, midnight và Ops Date 05:00.
- [ ] Test Pax `null/0/numeric/text-invalid` cho ARR và DEP.
- [ ] Test Stand/Gate/Counter/Carousel normalization đã khóa.

**Checkpoint:** Hai file cho cùng canonical leg contract và diagnostics có row/cell.

### Task 3 — Thêm schema canonical, provenance và lifecycle

**Create:**

- `app/supabase/migrations/<next_timestamp>_canonical_flight_leg_store.sql`
- `app/supabase/tests/canonical_flight_leg_store_schema.sql`

**Modify:**

- `app/supabase/schema.sql`
- generated/database types theo quy trình repo.

**Thực hiện:**

- [ ] Mở rộng/backfill `source_kind`.
- [ ] Thêm provenance/supersession/deletion reason.
- [ ] Chuẩn hóa Stand thành text xuyên schema.
- [ ] Tạo replacement scope metadata.
- [ ] Tạo active predicate helper hoặc view dùng chung.
- [ ] Thêm consistency constraint/diagnostic cho `status/action` deleted.
- [ ] Tạo new unique active occurrence index theo kiểu validate/cutover an toàn.

**Checkpoint:** Migration chạy được trên PostgreSQL 17 clone; rollback schema đã được diễn tập.

### Task 4 — Migrate manual-added legs về canonical table

**Thực hiện:**

- [ ] Backfill từng active `season_modification_added_legs` thành `season_flight_records(source_kind='manual', action='added')`.
- [ ] Giữ mapping old `leg_id` -> new `record_id` để re-key overlays/audit/links.
- [ ] Phát hiện identity collision trước write; không first-row-wins.
- [ ] Dual-read tạm thời chỉ phục vụ reconciliation, không tạo duplicate effective leg.
- [ ] Chuyển create-added-leg RPC sang insert canonical row.
- [ ] Chuyển edit/delete added leg sang canonical record + overlay contract.

**Checkpoint:** Count/checksum effective trước và sau giống nhau; đường write mới không tạo row ở legacy added-leg table.

### Task 5 — Tạo canonical effective read boundary

**Modify:**

- `app/supabase/schema.sql` và migration tương ứng;
- `app/src/lib/effectiveSeasonalLegs.ts`;
- server/client transport đọc workspace.

**Thực hiện:**

- [ ] View/RPC lấy base active từ một predicate duy nhất.
- [ ] Áp dụng modification overlay đúng precedence.
- [ ] Loại bỏ union legacy added-leg sau backfill.
- [ ] Xuất `source_kind`, source batch, effective action/status, Ops Date và version.
- [ ] Contract test so sánh SQL resolver với TypeScript resolver trên cùng fixture.

**Checkpoint:** Không còn ba cách khác nhau để xác định active/deleted leg.

### Task 6 — Refactor Daily stage/preview cho target canonical

**Modify/Create dự kiến:**

- Daily import types/parser/validation/transport hiện hành;
- migration/RPC stage/status/cancel;
- SQL tests cho preview.

**Thực hiện:**

- [ ] Batch legs chỉ là staged rows, không phải live schedule.
- [ ] Preview query canonical effective view và replacement scopes.
- [ ] Trả count/Pax/checksum trước-sau theo ngày/A-D/source.
- [ ] Trả overlay rebase plan và ambiguity diagnostics.
- [ ] Gắn payload hash, normalization policy version, expected data versions.
- [ ] Typed confirmation cho range và zero-flight days.

**Checkpoint:** Preview bất biến, đủ để operator biết chính xác dữ liệu nào sẽ bị thay thế.

### Task 7 — Implement Daily commit atomic vào `season_flight_records`

**Modify/Create dự kiến:**

- RPC commit migration kế tiếp, không sửa trực tiếp migration đã chạy;
- `app/supabase/tests/daily_schedule_canonical_commit.sql`;
- fault-injection/PGlite test nếu phù hợp với harness hiện hành.

**Thực hiện:**

- [ ] Idempotency + common season lock + stale version guard.
- [ ] Soft-delete toàn bộ active Seasonal/Daily/Manual leg trong exact affected scope.
- [ ] Insert toàn bộ Daily legs với provenance.
- [ ] Rebase overlay theo whitelist và unique match.
- [ ] Upsert replacement scopes.
- [ ] Server-side count/Pax/identity/checksum assertions.
- [ ] Audit/receipt/version/event trong cùng transaction.
- [ ] Không cập nhật `daily_schedule_active_days` trong canonical path.

**Checkpoint:** Inject lỗi sau delete, giữa insert và trước audit đều rollback về checksum ban đầu.

### Task 8 — Làm tương thích luồng sửa/xóa hiện hành

**Modify dự kiến:**

- `app/src/app/daily/page.tsx`
- `app/src/app/detailed/EditModal.tsx`
- `app/src/lib/dailySchedule.ts`
- save/upsert modification RPC và related tests.

**Thực hiện:**

- [ ] UI/API không phân nhánh sai theo source khi edit/delete.
- [ ] Không cho save lên base record đã `deleted/superseded`.
- [ ] Stale client nhận conflict thay vì tạo overlay mồ côi.
- [ ] Rebase giữ deleted overlay terminal khi match duy nhất.
- [ ] Resource overlay không ghi đè Pax/schedule mới ngoài whitelist.

**Checkpoint:** Cùng test suite edit/delete pass cho Seasonal, Daily và Manual leg.

### Task 9 — Giới hạn Seasonal rebuild vào Seasonal baseline

**Modify dự kiến:**

- Seasonal Merge/Full Replace/rebuild RPC trong migrations/schema;
- `app/supabase/tests/seasonal_rebuild_daily_authority.sql`;
- plan/tests V3 hiện hành.

**Thực hiện:**

- [ ] Thay mọi assumption `source_kind='imported'` bằng policy `seasonal` rõ ràng.
- [ ] Dùng common lock/version guard.
- [ ] Không mutate Daily/Manual rows.
- [ ] Consult replacement scopes trước activate Seasonal row.
- [ ] Test zero-flight Daily scope không bị resurrect.
- [ ] Repair/reset Daily authority là RPC riêng, permission/preview/typed confirmation riêng.

**Checkpoint:** Seasonal Merge và Full Replace chạy sau Daily commit không đổi Daily checksum/effective result.

### Task 10 — Cắt mọi consumer sang canonical view

**Modify dự kiến:**

- Daily/Detailed/Seasonal/Gate/Check-in queries;
- `reporting.effective_flight_operations`;
- sibling public traffic-report source migration;
- realtime/cache invalidation hooks.

**Thực hiện:**

- [ ] Tạo inventory query trước/sau và xóa fallback theo active pointer.
- [ ] Report projection chỉ build từ canonical effective view.
- [ ] Projection lưu source data version/watermark và refresh status.
- [ ] UI phân biệt empty thật với stale/not-refreshed projection.
- [ ] Một commit phát một logical schedule change event, consumer revalidate idempotently.

**Checkpoint:** Cùng một filter season/Ops Date cho cùng counts, identities và Pax ở mọi consumer.

### Task 11 — Rehearsal migration bằng production clone cô lập

**Không dùng production live write.**

- [ ] Backup schema/data cần thiết và restore vào PostgreSQL 17 clone cô lập.
- [ ] Chạy schema migration, manual-leg backfill và current Daily batch conversion.
- [ ] So sánh preimage, canonical base, effective view và report projection.
- [ ] Chạy Daily commit lần hai để kiểm chứng prior Daily supersession.
- [ ] Chạy Seasonal Merge/Full Replace sau Daily để kiểm chứng không resurrect.
- [ ] Diễn tập rollback từng phase và rollback toàn release.
- [ ] Ghi thời gian lock/transaction, index build và projection refresh.

**Checkpoint:** Có signed reconciliation artifact và rollback evidence trước khi xin phê duyệt production.

### Task 12 — Rollout production theo phase có feature flag

**Phase A — Additive schema:**

- thêm columns/table/view/index mới, chưa đổi read/write path;
- chạy diagnostics và backfill có kiểm soát.

**Phase B — Shadow reconciliation:**

- canonical view chạy song song để so sánh;
- legacy path vẫn phục vụ người dùng;
- mismatch làm dừng rollout.

**Phase C — Canonical read cutover:**

- chuyển từng consumer sang canonical view;
- theo dõi counts/Pax/version/projection freshness.

**Phase D — Canonical write cutover:**

- bật Daily canonical commit;
- bật Manual canonical insert;
- bật Seasonal source-scoped rebuild.

**Phase E — Production Daily remediation:**

- migrate active Daily batch hiện có vào canonical table bằng transaction đã rehearsal;
- reconcile exact affected scope trước mở report.

**Phase F — Decommission legacy authority:**

- ngừng đọc `daily_schedule_active_days`;
- ngừng tạo live rows trong `season_modification_added_legs`;
- chỉ drop/archive legacy structure ở release sau, khi hết rollback window và có phê duyệt riêng.

**Checkpoint:** Mỗi phase có go/no-go, metrics và rollback riêng; không “big bang”.

### Task 13 — Tài liệu vận hành và acceptance

- [ ] Cập nhật ADR mô tả canonical live leg store, overlays, replacement authority và projection.
- [ ] Runbook preview/commit/unknown outcome/reconcile/rollback.
- [ ] Runbook explicit Daily authority reset.
- [ ] Dashboard audit theo batch/Ops Date/count/Pax/version.
- [ ] UAT với Daily, Seasonal, Gate, Check-in và report owner.

**Checkpoint:** Operator có thể trả lời leg đến từ đâu, batch nào thay thế nó và report đang ở source version nào.

---

## 8. Test matrix bắt buộc

| Nhóm | Tình huống | Kỳ vọng |
|---|---|---|
| Parser | `.xls` OperationalTurns và `.xlsx` LB, tiêu đề khác nhưng vị trí giống | Cùng canonical contract |
| Parser | Row lỗi, date lỗi, side dở dang | Batch invalid; không xóa gì |
| Resource | `Stand20A`, `G1`, bare `G`, `C30`, `M1` | `20A`, `1`, `null`, `30`, `M1` |
| Ops Date | 04:59, 05:00, qua nửa đêm | Ops Date đúng ngưỡng 05:00 |
| Range | Nhiều ngày liên tục | Preview và replace đúng min/max |
| Range | Gap giữa hai ngày có leg | Bắt explicit zero-flight confirmation |
| Range | Leading/trailing ngày trống chỉ có trong tên file | Không tự xóa; yêu cầu explicit scope |
| Pax | null, 0, số hợp lệ, text lỗi | Giữ null/0; lỗi chặn commit |
| Identity | Duplicate full key | Commit bị chặn |
| Identity | Loose collision | Không rebase tự động |
| Replace | Seasonal legs trong scope | Old rows deleted; Daily rows active |
| Replace | Prior Daily legs trong scope | Prior rows deleted; batch mới active |
| Replace | Manual legs trong scope | Old manual rows deleted theo preview |
| Atomic | Lỗi sau soft delete | Rollback toàn bộ |
| Atomic | Lỗi giữa insert | Rollback toàn bộ |
| Atomic | Lỗi audit/version/event | Rollback toàn bộ |
| Concurrent | Hai Daily import overlap | Một commit; commit còn lại stale/conflict |
| Concurrent | Daily và Seasonal overlap | Common lock + policy cho deterministic result |
| Overlay | Gate/Stand/Counter match duy nhất | Rebase đúng whitelist |
| Overlay | Schedule/route/Pax cũ | Không ghi đè dữ liệu Daily mới |
| Overlay | Deleted overlay match duy nhất | Leg mới vẫn effective deleted |
| Overlay | Ambiguous/no-match | Preview invalid hoặc explicit resolution |
| Edit | Sửa/xóa Daily leg mới | Save đúng canonical ID; no orphan overlay |
| Seasonal | Merge sau Daily scope | Không thay Daily |
| Seasonal | Full Replace sau zero-flight Daily scope | Không resurrect Seasonal leg |
| Manual | Add/edit/delete manual leg | Chỉ canonical base + overlay, không legacy live row |
| Read | Daily/Gate/Check-in/Seasonal | Cùng counts/identity |
| Report | Live canonical và projection | Cùng Pax/count tại cùng source version |
| Realtime | Commit và unknown network outcome | Receipt/idempotent revalidate; không double apply |
| Rollback | Disable new write/read flags | Legacy path phục hồi trong rollback window |

---

## 9. Reconciliation mục tiêu cho batch production hiện có

Các số dưới đây là checkpoint từ lần kiểm tra hiện tại, phải được refresh lại ngay trước rehearsal/production và không được hard-code vào migration:

- File: `LB_20260823_20260827.xlsx`.
- Batch: `0b4ba05e-d42a-485d-a97e-366b8b5bef43`.
- Ops Date: 2026-08-23 đến 2026-08-27.
- Daily staged/source legs: 596.
- Seasonal/base legs cũ trong range: 669.
- Operational overlays cần đánh giá/rebase: 45.
- Deleted overlays: 2.
- Effective expected sau overlay deletion: 594 legs.
- Raw imported Pax total: 102,537.
- Effective Pax expected sau deleted overlays: 102,307.

Production remediation chỉ được chạy khi preview/rehearsal xác nhận:

1. exact 669 old active rows trong scope được chọn đúng và có preimage;
2. 596 Daily rows insert không collision;
3. 45 overlays có outcome rõ ràng, không silent loss;
4. 2 deleted overlays vẫn terminal;
5. canonical effective = 594 legs và Pax = 102,307 tại cùng data version;
6. report projection sau refresh có cùng kết quả;
7. transaction rollback đã được diễn tập trên clone.

Nếu số liệu production đã đổi, dừng và tạo reconciliation mới; không ép migration theo số cũ.

---

## 10. Rollback boundaries

### Trước canonical write cutover

- Tắt feature flag read mới.
- Giữ additive schema, quay consumer về legacy read.
- Không cần reverse data nếu chỉ shadow/read.

### Sau manual-leg backfill nhưng trước ngừng legacy write

- Dùng migration mapping để tránh duplicate effective row.
- Quay read path về legacy; không hard-delete canonical backfill cho đến khi đối soát.

### Sau Daily canonical commit

- Không rollback bằng cách xóa tùy ý batch mới.
- Dùng audited reversal transaction:
  - mark Daily rows của batch rollback deleted;
  - restore exact preimage old rows về state trước commit;
  - restore overlays/scope/version theo receipt;
  - refresh projection và phát rollback event.
- Reversal phải có preview, permission và idempotency riêng.

### Sau legacy decommission

- Chỉ drop bảng/pointer sau một release ổn định và backup/restore rehearsal.
- Drop là migration riêng, không gộp với write cutover.

---

## 11. Go/No-Go production

### Go khi tất cả đúng

- PostgreSQL 17 clone rehearsal pass.
- Tất cả atomic fault tests pass.
- Seasonal Merge/Full Replace không làm thay đổi Daily authority.
- Edit/delete Daily/Seasonal/Manual pass cùng contract.
- Counts/identity/Pax khớp ở live view và report tại cùng version.
- Không còn consumer live dùng active Daily snapshot/pointer.
- Có backup, rollback receipt và người phê duyệt production.

### No-Go nếu có một trong các điều kiện

- Có invalid/ignored workbook row trong affected scope.
- Có duplicate hoặc loose identity ambiguity chưa xử lý.
- Có pending draft/pending sync/stale version.
- Có overlay không xác định được rebase outcome.
- Report projection không chứng minh được source version.
- Migration cần hard-delete hoặc sửa production ngoài transaction đã rehearsal.
- Counts/Pax/checksum không khớp.

---

## 12. Definition of Done

Chỉ coi hoàn tất khi có bằng chứng code/test/log rằng:

1. Cả hai loại file Daily được parse theo cùng position-based contract và Ops Date policy.
2. Preview nêu chính xác affected days, count, Pax, identity conflict và overlay outcome.
3. Daily commit soft-delete leg cũ và insert leg mới vào `season_flight_records` trong cùng transaction.
4. Failure injection chứng minh rollback giữ nguyên preimage.
5. Unique active occurrence được bảo vệ xuyên `seasonal|daily|manual`.
6. Manual-added live leg không còn phụ thuộc `season_modification_added_legs`.
7. Edit/delete hiện hành hoạt động đúng trên mọi source và không tạo orphan/stale overlay.
8. Seasonal rebuild chỉ quản lý Seasonal baseline, tôn trọng Daily replacement scope và không resurrect zero-flight day.
9. Daily, Gate, Check-in, Seasonal và reporting đọc cùng canonical effective view.
10. Report Pax/count khớp canonical view tại cùng source version.
11. Production batch hiện hữu được reconcile/migrate có receipt, hoặc được ghi rõ chưa triển khai production.
12. Legacy active pointer/snapshot không còn là nguồn live; chỉ bị drop sau rollback window và phê duyệt riêng.

---

## 13. Thứ tự thực hiện đề xuất

```text
Characterization tests
  -> additive canonical schema
  -> manual-leg backfill + canonical effective view
  -> Daily stage/preview target mới
  -> Daily atomic commit
  -> edit/delete compatibility
  -> Seasonal source-scoped rebuild
  -> consumer/report cutover
  -> isolated clone rehearsal
  -> production phased rollout
  -> legacy decommission ở release sau
```

Ưu tiên không đảo thứ tự giữa canonical effective view, Daily write cutover và Seasonal rebuild. Bật Daily canonical write trước khi Seasonal path biết tôn trọng `source_kind='daily'` và replacement scope sẽ tạo cửa sổ làm mất hoặc làm sống lại dữ liệu.
