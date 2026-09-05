# Audit Seasonal import/export và Daily import

Ngày kiểm tra: 2026-09-05; hoàn tất báo cáo ngày 2026-09-06. Phạm vi: audit, không sửa code, không chạy migration, không import hoặc sửa dữ liệu production.

## Kết luận

**Chưa đáp ứng đầy đủ thiết kế canonical/atomic flight.** Transaction Daily có các kiểm tra rollback/idempotency đang chạy đạt, nhưng atomic transaction không bảo đảm đúng nghiệp vụ nếu phạm vi ngày hoặc việc chuyển tiếp deleted overlay bị tính sai.

Hai lỗi ưu tiên cao nhất đã tái hiện trên database PGlite dùng một lần hoặc fixture parser:

1. Một chuyến đã xoá có thể sống lại sau Seasonal Full Replace hoặc lần Daily import đầu tiên lên dữ liệu Seasonal có provenance batch.
2. Ngày đầu/cuối file chỉ có chuyến bị loại bởi rule `CX`/`Cancelled` biến mất khỏi phạm vi Daily replacement; dữ liệu cũ của ngày đó không bị thay thế.

Ngoài ra có lỗi Merge Seasonal lặp lại, export bị chặn bởi dữ liệu lịch sử/stand dạng text, và sự không thống nhất của flight identity giữa các luồng.

Không phát hiện duplicate active occurrence hoặc active link trỏ tới row không active trong truy vấn production tại thời điểm kiểm tra. Điều này không loại trừ các lỗi lifecycle đã tái hiện bằng fixture.

## 1. Nguồn bằng chứng và giới hạn

- Checkout kiểm tra: `3d928ce`; remote `main` quan sát được là `8d83783`, một ancestor của checkout hiện tại. Các thay đổi chưa commit sẵn có của người dùng được giữ nguyên.
- Đọc ADR `docs/adr/2026-08-29-canonical-flight-leg-store.md`, kế hoạch canonical ngày 2026-08-29 và runbook liên quan.
- Đọc parser, contract, handler UI, snapshot materializer, migration định nghĩa/patch các RPC đang dùng.
- Chạy unit/source test hiện có và các probe bổ sung trong bộ nhớ. Probe bổ sung chưa được lưu thành regression test trong repo.
- Đối chiếu production qua SSH/psql, chỉ trong transaction `READ ONLY`, có giới hạn thời gian câu lệnh. Không stage batch, commit, reset, refresh projection hoặc ghi dữ liệu production.
- Không thực hiện thao tác UI có đăng nhập hoặc import lại workbook thực tế trong đợt audit này. Các case mới dùng fixture tổng hợp để cô lập lỗi.
- PGlite xác minh logic SQL và rollback trong test; không thay thế kiểm thử concurrency nhiều connection, HTTP gateway hoặc hiệu năng PostgreSQL production.

## 2. Luồng hiện tại và thiết kế đối chiếu

| Luồng | Entry point và contract | Nguồn dữ liệu |
| --- | --- | --- |
| Seasonal import | `app/src/app/(desktop)/SeasonalSchedulePage.tsx:1836`; `parseSeasonalSchedule`; `prepareSeasonalImportV3Attempt`; stage/preview/commit V3 | Source rows, canonical `season_flight_records`, modifications, import batch và audit |
| Season export | `SeasonalSchedulePage.tsx:995`; `getSeasonalExportSnapshot`; `get_seasonal_export_snapshot_v2`; strict snapshot validation; `materializeEffectiveSeasonalLegs`; `buildCanonicalSeasonalRows`; duplicate và round-trip validation | RPC hiện trả toàn bộ rows/history của season; client mới materialize effective state |
| Daily import | `app/src/app/(desktop)/daily/page.tsx:904`; `analyzeDailyScheduleWorkbook`; `buildDailyImportStagePayloadV1`; stage/preview/commit V1 | Batch legs là staging/audit; commit cập nhật canonical store, overlays và Daily replacement scopes |

Thiết kế hiện hành:

- Canonical active: `status='active' AND action IS DISTINCT FROM 'deleted'`.
- Daily thay thế mọi nguồn trong exact affected Ops Dates, giữ preimage lịch sử và rebase overlay hợp lệ trong cùng transaction.
- Seasonal chỉ thay đổi nguồn Seasonal; không kích hoạt baseline tại ngày còn Daily authority.
- Deleted overlay phải tiếp tục có hiệu lực khi match duy nhất; không được coi một import thông thường là Undo.
- Ops Date theo `Asia/Ho_Chi_Minh`, cutoff 05:00. Ngày zero-flight cần xác nhận rõ; tên file chỉ là gợi ý.
- `stand` có thể là text; Pax `NULL` khác Pax `0`.

## 3. Findings ưu tiên

### F01 — P1: Import có thể làm sống lại chuyến đã xoá

**Đã tái hiện bằng SQL trong PGlite, hai đường đi độc lập.**

**A. Seasonal Full Replace**

- `app/supabase/migrations/20260829170000_seasonal_canonical_authority.sql:83-96` chỉ tìm Seasonal occurrence đang canonical-active để rebase.
- Canonical delete chuyển base thành `deleted/deleted`, với reason `overlay_deleted`; row đó không còn nằm trong tập match.
- Full Replace tạo record ID mới theo batch, nhưng không chuyển deleted overlay của tombstone sang record mới.

Tái hiện:

1. Import Seasonal để row có `source_import_batch_id`.
2. Xoá `VN202`, ngày 2026-08-24 bằng `save_canonical_season_modification_v1`.
3. Full Replace bằng file vẫn chứa chuyến này.
4. Commit thành công; record mới có `status=active`, `action=null`, không có deleted overlay. Chuyến xuất hiện lại dù không Undo.

**B. Daily import đầu tiên sau khi xoá một row Seasonal**

- `app/supabase/migrations/20260831124500_daily_overlay_authority_scope_match.sql:28-40` cho match terminal row nếu batch thuộc active Daily scope, hoặc row không có source batch và chưa có active scope.
- Tombstone Seasonal có batch khác null, chưa có Daily scope, không thuộc hai nhánh này.
- Probe cho kết quả stage `matchedCount=0`, `overlayRebaseCount=0`; commit tạo một active leg từ chuyến đã xoá.

Production hiện không có terminal Seasonal row với non-null batch trong truy vấn kiểm tra; chưa có bằng chứng lỗi này đã xảy ra với dữ liệu thật.

Hướng sửa: thống nhất resolver nhận diện terminal overlay theo authority và lineage; phân biệt user deletion với superseded history. Khoá bằng test trước, không mở rộng match một cách vô điều kiện vì có thể kéo lại overlay cũ sau reset/Undo hợp lệ.

### F02 — P1: Lọc chuyến huỷ làm mất ngày khỏi phạm vi thay thế

**Đã tái hiện bằng parser và stage-payload fixture.**

- `app/src/lib/dailyScheduleImport.ts:484-510` bỏ side có `CX` hoặc `Cancelled` trước khi tạo legs.
- `app/src/lib/dailyImportV1Contract.ts:145-172` lấy season/range/affected dates chỉ từ legs còn lại.
- `app/src/app/(desktop)/components/DailyImportPreviewDialog.tsx:26` chỉ mở xác nhận zero-flight khi đã có `DAILY_COVERAGE_GAP`.

Ví dụ: file có 02/09 chỉ gồm chuyến Cancelled, 03/09 có chuyến hợp lệ. Payload chỉ ảnh hưởng 03/09, không có diagnostic. Nếu DB đang có chuyến ngày 02/09 thì những chuyến đó còn nguyên.

Nếu ngày bị huỷ nằm giữa hai ngày có legs, gap được phát hiện. Nếu nằm đầu/cuối thì mất hoàn toàn. Nếu toàn file đều bị huỷ, parser trả legs và targets rỗng, server chặn `DAILY_EMPTY`; UI không có đường xác nhận để thay một ngày bằng tập rỗng.

Hướng sửa: lưu coverage hợp lệ của nguồn độc lập với tập legs sau lọc, cho operator xác nhận zero-flight dates, hỗ trợ zero-leg replacement có scope rõ. Không tự lấy range từ tên file và không tự xoá dữ liệu ở các ngày chưa được xác nhận.

### F03 — P2: Merge Seasonal lặp lại có preview hợp lệ nhưng commit lỗi duplicate ID

**Đã tái hiện bằng SQL trong PGlite.**

1. Ngày đã có Daily authority.
2. Merge Seasonal thêm baseline cho ngày đó: thành công, baseline được giữ inactive với reason `daily_authority`.
3. Stage cùng nội dung ở batch tiếp theo, đúng data version: preview vẫn `validated`, báo insert một occurrence.
4. Commit báo SQLSTATE `23505`: `Generated record ID LEG_D_2026-08-23_9bf874a96f63442369765bd61103cbef conflicts with an existing record`.

Nguyên nhân:

- Match merge chỉ lấy active records, bỏ qua baseline inactive lần trước.
- ID theo batch chỉ được áp dụng cho `replace`, không áp dụng cho merge: `20260829170000_seasonal_canonical_authority.sql:100-105`.
- Guard ID ở `20260817173000_make_seasonal_replace_full_reset.sql:1136` vẫn kiểm tra toàn bộ history.

Transaction không để lại dữ liệu ghi dở, nhưng import lặp lại bị chặn sau một preview báo sẵn sàng.

Hướng sửa: xác định rõ cơ chế reuse hoặc generation ID cho inactive baseline khi merge; đồng thời giữ các bảo vệ terminal deletion ở F01.

### F04 — P2: Export đọc history và có thể bị chặn bởi manual row đã superseded

**RPC production đã được đối chiếu; lỗi validation đã tái hiện bằng snapshot fixture.**

- `app/supabase/migrations/20260721090000_fix_seasonal_export_snapshot_identity_counts.sql:44-64` trả tất cả `season_flight_records`, không filter canonical-active. Các relation modifications đi theo snapshot này.
- Client có bước effective materialization, vì vậy không thể kết luận rằng mọi history row đều được xuất ra XLSX hoặc hiện đang có duplicate trong file.
- Tuy nhiên strict validator chạy trước materialization. `app/src/lib/seasonalExportSnapshot.ts:275-289` yêu cầu modification `action=added` phải trỏ tới canonical manual row còn active/action added.
- Daily replacement soft-delete manual preimage, còn modification lịch sử có thể vẫn mang `action=added`.

Snapshot fixture tương ứng bị từ chối với lỗi: `Added modification added-record must not reference a non-manual base flight record.`

Production chưa có historical manual-added overlay thuộc case này tại thời điểm kiểm tra. Nhưng RPC vẫn tải history: S26 có 65.192 physical rows so với 25.344 active; W25 có 30.379 so với 15.229 active.

Hướng sửa: export snapshot phải có contract active/effective rõ ở backend, filter các relation liên quan nhất quán và giữ version pin. Không chỉ thêm một filter UI sau khi strict validator đã chạy.

### F05 — P2: Stand dạng text trong overlay chặn Season export

**Đã tái hiện bằng snapshot fixture.**

- Validator base row đã cho phép stand dạng text: `seasonalExportSnapshot.ts:116-118`.
- Validator modification vẫn yêu cầu integer cho `stand`: cùng file dòng 161.
- Cả `stand='20A'` và `stand='20'` đều bị lỗi `modifications[0].stand must be an integer or null.`

Lệch với schema/contract stand text hiện hành. Production không có active stand overlay ở lần đọc kiểm tra, nên chưa kết luận lỗi này đang chặn một export thật.

Hướng sửa: dùng cùng kiểu/normalizer stand cho base và overlay, test `20A`, numeric-string, null và legacy integer.

### F06 — P2: Seasonal và Daily chuẩn hoá flight suffix khác nhau

**Đã tái hiện bằng parser fixture.**

- Daily (`app/src/lib/dailyScheduleImport.ts:381`) chuẩn hoá `VN1A` thành `VN001A`.
- Seasonal (`app/src/lib/parser.ts` và `20260817160000_optimize_seasonal_import_flight_normalization.sql`) giữ `VN1A`, chỉ pad khi phần sau airline hoàn toàn là số.
- Overlay matching so sánh flight number đã lưu, nên cùng một chuyến theo nghiệp vụ có thể không match khi chuyển Seasonal sang Daily.

Hướng sửa: chọn một contract chuẩn hoá dùng chung TypeScript/SQL, test round-trip và overlay matching. Chưa tự sửa lại flight identity trong production; cần đánh giá dữ liệu đang tồn tại trước.

### F07 — P2: Daily strict identity và duplicate policy của Season export không đồng nhất

**Đã tái hiện ở parser/export validator; chưa chạy end-to-end import database cho case này.**

- Daily key phân biệt Ops Date, side, airline, flight number, route và scheduled time.
- `app/src/lib/atomicSchedule.ts:775-784` kiểm tra duplicate theo calendar date + airline + flight number, không phân biệt giờ/route; Seasonal V3 cũng có occurrence policy hẹp hơn Daily.
- Hai DEP `VN777` cùng ngày, giờ 10:00 và 12:00: Daily strict parser trả hai legs, không diagnostic; export validator báo duplicate flight.

Đây là bất đồng contract cần quyết định nghiệp vụ: có cho phép lặp flight number trong ngày hay không. Không được chữa bằng cách lặng lẽ bỏ một chuyến khi export.

### F08 — P2: Commit thành công nhưng refresh lỗi có thể bị báo thành commit thất bại

**Xác nhận qua control flow; chưa fault-inject trên desktop UI.**

- `app/src/app/(desktop)/daily/page.tsx:976-998`: `applyCommittedDailyImport` xoá preview trước, rồi await revalidate workspace.
- Hàm được gọi trong cùng `try/catch` với commit ở dòng 1037-1040; lỗi revalidate cũng hiển thị `Daily Import Commit Failed`.
- Như vậy thông báo không phân biệt DB đã commit với đọc lại dữ liệu thất bại. Receipt không được giữ trong một recovery state bền như Seasonal.

Hướng sửa: giữ committed receipt, tách trạng thái committed/refresh-pending, chỉ retry read khi commit đã được xác nhận. Không tự commit lại theo thông báo lỗi refresh.

### F09 — P2: Preview hiển thị số liệu đầu vào thay vì trạng thái effective sau commit

**Xác nhận qua SQL và binding UI.**

- Stage SQL trả riêng `effectiveAfterCount`, `effectiveAfterPax` sau rebase overlay.
- `app/src/app/(desktop)/components/DailyImportPreviewDialog.tsx:125-127` lại gắn nhãn “Chuyến sau”/“Pax sau” cho `afterCount`/`afterPax`.
- Khi deleted/Pax overlay còn hiệu lực, số hiển thị có thể khác dữ liệu canonical effective mà report đọc sau commit.

Hướng sửa: thể hiện riêng số lượng file và effective sau commit; giữ Pax null khác zero, công khai ảnh hưởng của overlay.

## 4. Gap tương thích và vận hành

### G01 — Header Daily vẫn bị ràng buộc dù field mapping theo vị trí

`app/src/lib/dailyScheduleWorkbook.ts:127-133` yêu cầu bốn header identity khớp alias đã biết. Fixture đổi các tiêu đề identity nhưng giữ nguyên 43 vị trí bị `DAILY_WORKBOOK_LAYOUT_NOT_FOUND`.

Hai profile hiện có vẫn được nhận diện. Tuy nhiên chưa hỗ trợ mọi biến thể tiêu đề theo yêu cầu “vị trí các trường hoàn toàn giống nhau”. Cần thêm alias/profile selection hoặc kiểm tra cấu trúc có confidence rõ; không chấp nhận mù một sheet chỉ vì đủ số cột.

### G02 — Stale conflict Seasonal chưa thống nhất với Daily

RPC production stage/commit/export Seasonal còn dùng SQLSTATE `40001` cho business stale version; Daily đã dùng `PT409`. Đây là chênh lệch contract có thể ảnh hưởng retry/độ trễ ở gateway, **chưa tái hiện HTTP timeout của Seasonal trong đợt này**.

PostgREST có cơ chế custom status `PTxxx`; vấn đề retry `40001` từng được ghi nhận upstream. Cần một test HTTP giới hạn thời gian trên đúng gateway/version triển khai, không kết luận chỉ từ unit test. Tham khảo [PostgREST errors](https://docs.postgrest.org/en/v16/references/errors.html) và [upstream issue 3673](https://github.com/PostgREST/postgrest/issues/3673).

### G03 — Fix stage timeout đang có trên production nhưng chưa nằm trong main

Production stage đã có indexed Ops Date lookup và `PT409`. Migration `20260904183000_daily_import_stage_indexed_ops_date.sql` tồn tại tại worktree/branch `codex/daily-stage-opsdate-performance`, commit `6f05837`, chưa có trong checkout main đã audit hoặc remote main được kiểm tra.

Không phải bằng chứng production hiện còn chạy bản stage chậm cũ. Đây là rủi ro delivery: dựng database chỉ từ main không tái lập đúng hotfix đang chạy. Cần đưa migration và test của hotfix vào nguồn release có kiểm soát.

### G04 — Test gate và runbook có drift

- `test:atomic-flight` có source test vẫn mở đường dẫn trước khi chuyển sang route group `(desktop)`.
- `test:seasonal-import-v3-sql` lỗi bootstrap do tạo trùng role `service_role`, chưa tới assertions nghiệp vụ.
- Runbook Daily vẫn hướng dẫn typed confirmation dù yêu cầu này đã được bỏ theo chỉ đạo trước của người dùng. Chỉ cập nhật tài liệu, không khôi phục yêu cầu nhập chuỗi.

## 5. Phần đang hoạt động đúng và giới hạn kết luận

- Daily canonical commit test chạy đạt các failpoint sau delete, sau insert, trước audit: rollback giữ trạng thái ban đầu trong fixture.
- Retry cùng request trả receipt idempotent; test multi-season event identity chạy đạt.
- Seasonal authority test cơ bản xác nhận Merge/Replace không kích hoạt Seasonal trong Daily scope; manual/Daily và zero-flight authority scopes được giữ trong các case hiện có.
- Current production không có duplicate active occurrence trong truy vấn kiểm tra, không có active link trỏ đến inactive/missing row.
- Gate/Pax null overlay, interior zero-flight confirmation/reset và rule regression đang chạy đạt trong suite liên quan.
- Chưa chứng minh đầy đủ concurrent import trên PostgreSQL nhiều connection, UI refresh-failure recovery hoặc hiệu năng mọi range/file. Không suy diễn các test trên thành bảo đảm toàn bộ Check-in/Gate hay Dashboard không có lỗi.

## 6. Test đã chạy

Các lệnh chạy từ thư mục `app`.

| Test | Kết quả |
| --- | --- |
| `npm run test:daily-import` | PASS, 16/16 |
| `npm run test:atomic-flight` | 4 behavior tests PASS; 1 module FAIL do `ENOENT` đường dẫn source cũ |
| `node --experimental-strip-types --test src/lib/exporter.test.ts` | PASS, 7/7 |
| `node --experimental-strip-types --test src/lib/seasonalExportSnapshot.test.ts src/lib/seasonalExportSelection.test.ts src/lib/seasonalImportV3Contract.test.ts src/lib/seasonalImportRecovery.test.ts` | PASS, 42/42 |
| `npm run test:daily-canonical-commit` | PASS |
| `npm run test:seasonal-canonical-authority` | PASS |
| `npm run test:rules` | PASS |
| `npm run test:seasonal-import-v3-sql` | FAIL bootstrap, SQLSTATE `42710`, role `service_role` already exists |

Probe bổ sung không ghi file/database thật: terminal deletion Seasonal→Replace, terminal deletion Seasonal→Daily, repeated Merge trong Daily scope, cancellation boundary/all-cancelled, historical manual-added export, text stand export, suffix normalization, duplicate policy và header variants. Kết quả được mô tả tại từng finding; chưa đưa các probe này vào test suite chính thức.

Không chạy build/typecheck vì không thay đổi code. Hai suite hỏng hạ tầng/source path được ghi rõ, không tính là pass nghiệp vụ.

## 7. Đề xuất thứ tự sửa và acceptance

1. **Khoá data correctness trước:** thêm failing SQL tests F01 và parser/scope tests F02; sửa authority/terminal resolution và coverage độc lập. Bao phủ cả Seasonal có batch, legacy null batch, Daily reimport, explicit Undo/reset, multi-season, đầu/giữa/cuối file và all-cancelled.
2. **Sửa idempotent baseline lifecycle:** F03; chạy Merge lần 1/2/3, đổi time/route, deleted baseline, Daily authority reset; commit không lỗi ID, không sinh thêm active occurrence.
3. **Sửa export contract:** F04/F05; backend snapshot và child relations chỉ chứa tập export hợp lệ, tests history manual/superseded/deleted, stand text, source version mismatch. Không bỏ validation mà không có contract thay thế.
4. **Chốt identity:** F06/F07 trước mọi data repair. Test parser TS, normalization SQL, matching, export/reimport cùng một bộ fixture; xác nhận policy lặp flight number.
5. **Sửa trạng thái vận hành:** F08/F09, header variants, stale HTTP contract; test commit thành công nhưng refresh mất mạng, receipt recovery, số liệu effective và Pax null.
6. **Khôi phục gate/release lineage:** sửa test bootstrap/đường dẫn; đưa hotfix stage vào main; chạy lại suites, PostgreSQL clone rehearsal, concurrent/stale HTTP tests trước khi đề xuất production rollout.

Các thay đổi SQL/RPC hoặc dữ liệu production cần được phê duyệt riêng. Đợt audit này chỉ tạo báo cáo; chưa triển khai các đề xuất trên.
