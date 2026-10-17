# Báo cáo xác minh Export Excel lịch mùa

Ngày kiểm chứng: 2026-10-13.

## 1. Phạm vi và kết luận

Luồng được sửa là Export Updated của lịch mùa và Export Excel lịch sử phiên bản, cùng dùng `app/src/lib/canonicalSeasonalRows.ts`. Template chính có 25 cột, ARR/DEP song song. Không sửa schema, migration, query, importer hoặc thứ tự cột.

Đã tái hiện lỗi trước sửa: cặp K6 đến ngày 25/10 và đi ngày 26/10 bị xuất thành một dòng; test mong đợi hai dòng nhận kết quả `1 !== 2`. Sau sửa, kiểm chứng xuất XLSX và đọc lại thành công cho cùng ngày, khác ngày và chuyến đơn. File mẫu: `tmp/export_excel_verified_sample.xlsx`.

Không khẳng định đã kiểm chứng database production, UI tải file hoặc importer của hệ thống bên ngoài. Luồng được thực thi là builder → XLSX Blob → bytes/file → SheetJS → parser/materializer hiện hành.

## 2. Mapping từ cơ sở dữ liệu mới

| Dữ liệu | Trường DB mới | Trường ứng dụng | Công dụng |
| --- | --- | --- | --- |
| ID chặng draft | `seasonal_flight_drafts.draft_id` | `id`, `draftId` | Nhận diện từng chặng |
| Chặng đối ứng | `linked_draft_id` | `linkedRecordId` | Ghép cặp hai chiều |
| Mã turnaround | `turnaround_id` | `turnaroundId` | Dấu vết cặp chung |
| Mã liên kết | `link_id` | `linkId` | Fallback định danh liên kết |
| Loại cặp | `link_type` | `linkType` | `sameday` / `overnight` |
| Ngày neo | `pair_anchor_date` | `pairAnchorDate` | Phân biệt occurrence trong chuỗi liên kết |
| Ngày, giờ scheduled | `date`, `scheduled_date`, `scheduled_time`, `schedule` | `date`, `scheduledDate`, `scheduledTime`, `schedule` | Ngày và giờ dùng để import lịch mùa |
| Ngày vận hành | `operational_date` | `operationalDate` | Giữ riêng với scheduled date |

Bằng chứng:

- `app/supabase/migrations/20260928120000_seasonal_operational_separation_schema.sql`: định nghĩa `seasonal_flight_drafts`, các trường liên kết ở dòng 58–63; bảng `operational_flight_legs` lưu ngày scheduled và operational riêng.
- `app/src/lib/seasonalPlanningSaveManager.ts`, hàm `seasonalDraftExportSnapshotToFlightRecords`: map ID, ngày/giờ, `link_type`, `pair_anchor_date`, `linked_record_id`/`linked_draft_id`, `turnaround_id` sang `FlightRecord`.
- RPC draft `get_seasonal_draft_export_snapshot_v1` trả về đầy đủ draft, alias `draft_id` thành `record_id` và `linked_draft_id` thành `linked_record_id`. RPC published `get_seasonal_published_export_snapshot_v1` cũng giữ dữ liệu liên kết trong snapshot.
- `app/src/lib/seasonalPairing.ts`, hàm `resolveSeasonalPairs`: dùng liên kết hai chiều, turnaround, hoặc bộ khóa link ID/ngày neo/loại cặp; không đoán cặp bằng số hiệu chuyến bay gần nhau.

Kết luận: DB và adapter hiện tại đủ dữ liệu xác định cặp khác ngày; không cần bổ sung truy vấn. Schema/model không có Registration. `Aircraft` là loại tàu bay, không phải số đăng ký; không tạo giá trị giả để thay thế Registration.

## 3. Thuật toán nhóm dòng

1. Materialize records active và modifications; bỏ chặng deleted.
2. Nếu xuất theo selection, đóng selection trên toàn bộ cặp để không bỏ sót chặng đối ứng.
3. Resolve cặp bằng cơ chế hiện hành, giữ diagnostics cho cặp thiếu đối ứng, liên kết không hai chiều hoặc mơ hồ.
4. Chỉ cho phép một dòng chứa cả ARR và DEP nếu hai chặng có cùng `date` và template/importer có thể biểu diễn không làm đổi occurrence: cùng hãng, cùng loại tàu bay, giờ tương thích với cặp same-day.
5. Cặp qua đêm được gom theo **thuộc tính của cả ARR và DEP**, dùng ngày ARR làm neo. Chia complete run đúng một lần trên ngày neo, rồi sinh hai dòng: ARR theo run gốc, DEP theo toàn bộ run dịch +1 ngày. Thay đổi giờ/route/category/codeshare hoặc thuộc tính khác của một phía sẽ chia pattern của cả hai phía cùng ranh giới; chuyến đơn không được trộn vào nhóm cặp.
6. Chuyến đơn tạo candidate một phía; phía còn lại để trống.
7. Với từng cặp dòng qua đêm: Effective DEP = Effective ARR +1; Discontinue DEP = Discontinue ARR +1; Mon–Sun DEP là Mon–Sun ARR xoay một ngày, kể cả Sun→Mon và chuyển tháng/năm. Giữ từng giá trị thực tế của chặng, không tự sửa giờ hoặc route DEP cho giống ARR.
8. Giữ reference của từng occurrence trong từng run, không chỉ reference của occurrence mẫu; xuất sheet phụ để người đọc tìm lại cặp.
9. Validation so sánh multiset occurrence sau flatten/import với dữ liệu effective: loại chặng, ngày, hãng, số hiệu, chặng bay, giờ, loại tàu bay, category, codeshare, international/domestic. Luồng UI hiện hành chặn export khi validation thất bại.
10. Canonical rows qua đêm giữ `overnightLinkRowIndex` đối ứng và `linkType = overnight`. Rebuild source rows loại `pairReferences` trước khi diff/lưu; không persist danh sách FlightLeg của export. Đã kiểm chứng qua `applySourceRowRebuildPlan` rồi flatten dữ liệu gửi vào `replaceSourceRows`: 6 cặp còn liên kết đầy đủ và 1 chuyến đơn vẫn độc lập.
11. Chia giai đoạn theo **khoảng Effective–Discontinue hợp lệ dài nhất trước**, không tối ưu ít dòng nhất và không tách các thứ để tạo những khoảng giao nhau. Nếu hai khoảng cùng độ dài, ưu tiên nhiều occurrence hơn; nếu vẫn bằng nhau, ưu tiên ngày bắt đầu sớm hơn. Sau khi chọn giai đoạn chính, xử lý phần trước và sau bằng cùng quy tắc, rồi xuất các giai đoạn theo thứ tự thời gian.
12. Khoảng hợp lệ phải mở rộng đúng các occurrence trong khoảng: thiếu một ngày của thứ đang active sẽ ngắt nhịp; không tự điền tuần bị thiếu. Ngoại lệ ở đầu/cuối không được tiêu thụ một phần của giai đoạn dài hơn ở giữa. Với overnight, chỉ chia trên ngày neo ARR rồi dịch toàn bộ run DEP +1 như trên.

Triển khai tại `splitIntoCompleteRuns`: cache endpoint hợp lệ xa nhất cho từng ngày bắt đầu bằng cách đối chiếu số occurrence mỗi thứ với số lần thứ đó xuất hiện trong khoảng. Chọn giai đoạn theo span/count/start trong từng phần còn lại; dùng stack thay vì đệ quy. Không tạo Date hoặc quét từng ngày lịch lại cho mọi khoảng ứng viên. Độ phức tạp tối đa O(n²), bộ nhớ phụ O(n), với n là số ngày duy nhất trong một nhóm cùng thuộc tính.

**Không đặt mục tiêu số dòng ít nhất.** Quy tắc tie-break có thể tạo nhiều dòng hơn cách tham lam cũ, nhưng giữ giai đoạn dài nhất theo đúng tiêu chí nghiệp vụ đã chốt. Không thay đổi thứ tự header, query DB hoặc quy tắc ngày vận hành.

Các điều kiện biểu diễn của template vẫn được giữ, không coi dữ liệu mâu thuẫn hoặc cặp không hợp lệ là đã được hỗ trợ 100%. Đặc biệt, template có một cột Airline và một cột Aircraft dùng chung; không thể biểu diễn hai giá trị khác nhau trên cùng một dòng mà vẫn giữ nguyên template và importer.

## 4. Ngày, giờ và timezone

- Các ô ngày xuất ra là **text đồng nhất `D-MMM-YY`**, ví dụ `13-Oct-26`, theo format lịch mùa hiện hành. Không trộn Date object và text.
- Sheet phụ dùng cùng formatter cho Scheduled Date, Operational Date và Pair Anchor Date. Ô không có ngày neo để trống.
- Giờ được giữ từ schedule chuẩn của hệ thống, dạng `HH:mm`; không suy đoán hoặc dịch giờ theo timezone của máy xuất.
- Formatter và phép tính lịch hiện hành dùng UTC để thao tác trên chuỗi ngày date-only; không chuyển một timestamp địa phương rồi lấy ngày từ timezone máy.
- **Phân biệt quan trọng:** Effective/Discontinue của template lịch mùa là scheduled calendar date (`leg.date`), không phải bucket `operationalDate`. Hệ thống có cutoff ngày vận hành lúc 05:00. Chặng DEP scheduled ngày 25/10 lúc 02:30 có operational date 24/10; thay Effective thành 24/10 sẽ khiến importer lịch mùa dịch sai ngày scheduled. Vì vậy scheduled date dùng trên sheet lịch; operational date được bảo toàn ở sheet phụ.
- Ca biên 23:30 → 02:30 đã được kiểm chứng qua importer canonical: Departure giữ scheduled date `2026-10-25`, giờ `02:30`, operational date `2026-10-24`. Đây là cặp khác ngày scheduled, dù cùng ngày vận hành theo cutoff.

## 5. Cấu trúc workbook và link thủ công

### Sheet chính `S26` / mã mùa tương ứng

Giữ nguyên thứ tự 25 cột:

```text
Effective, Discontinue, Airline, Aircraft,
Mon, Tue, Wed, Thu, Fri, Sat, Sun,
STA, ARRFlight, ARRFlightType, ARRRoute, ARRCodeShares, ARRIntDomInd,
STD, DEPFlight, DEPFlightType, DEPRoute,
ARRFlightCategory, DEPFlightCategory, DEPCodeShares, DEPIntDomInd
```

### Sheet phụ `Pair References`

Mỗi occurrence có một reference, gồm:

```text
Schedule Row, Pair Key, Record ID, Linked Record ID, Link Type,
Pair Anchor Date, Type, Scheduled Date, Scheduled Time, Operational Date,
Airline, Aircraft, Flight, Route
```

- `Schedule Row` là số dòng Excel trên sheet chính, tính cả header: dòng dữ liệu đầu tiên là 2.
- Hai chặng same-day có hai reference trỏ cùng một dòng chính.
- Hai chặng cross-day có reference trỏ hai dòng khác nhau; giữ chung Pair Key và ID đối ứng gốc nếu DB cung cấp.
- Trường hợp fallback ghép bằng link ID/ngày neo/loại cặp vẫn giữ link ID làm Pair Key.
- Chuyến đơn không có pairing metadata có Pair Key và Linked Record ID để trống.
- Pair Key có thể đại diện chuỗi liên kết; khi tra cặp phải kết hợp ngày neo/ngày scheduled và ID đối ứng, không chỉ dựa vào Pair Key.
- Hãng, loại tàu bay, số hiệu và route của từng chặng được giữ trên reference tương ứng; không sao chép route ARR sang DEP.

Importer lịch mùa hiện tại chỉ đọc sheet đầu tiên. Nó phục hồi occurrence và tự ghép cặp same-day trên cùng dòng; **không tự đọc sheet phụ để ghép lại cặp khác ngày**. Muốn link thủ công: lọc Pair Key, đối chiếu ID đối ứng và ngày neo, tìm Schedule Row trên sheet chính. Hệ thống ngoài có thể dùng sheet phụ làm dữ liệu ánh xạ, nhưng cần triển khai logic đọc sheet phụ ở hệ thống đó; phiên này không sửa importer.

## 6. Bảng đối chiếu file mẫu

Tất cả chặng mẫu thuộc hãng YP, loại tàu bay 789, route ICN. Effective bằng Discontinue vì mỗi pattern mẫu chỉ có một ngày.

| Dòng Excel | Kịch bản | Effective | ARRFlight | STA | DEPFlight | STD | Pair Key |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | Cùng ngày | 13-Oct-26 | 621 | 20:40 | 622 | 22:45 | SAME-1 |
| 3 | Khác ngày — ARR | 14-Oct-26 | 621 | 20:40 | trống | trống | NIGHT-1 |
| 4 | Khác ngày — DEP | 15-Oct-26 | trống | trống | 622 | 22:45 | NIGHT-1 |
| 5 | Chuyến đơn | 16-Oct-26 | 701 | 20:40 | trống | trống | trống |

Sheet `Pair References` có 5 occurrence:

| Schedule Row | Pair Key | Record ID | Linked Record ID |
| --- | --- | --- | --- |
| 2 | SAME-1 | SAME-1-A | SAME-1-D |
| 2 | SAME-1 | SAME-1-D | SAME-1-A |
| 3 | NIGHT-1 | NIGHT-1-A | NIGHT-1-D |
| 4 | NIGHT-1 | NIGHT-1-D | NIGHT-1-A |
| 5 | trống | SINGLE-1 | trống |

## 7. Kiểm chứng đã chạy

Test được cập nhật tại `app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs`, tái dùng harness transpile hiện có, không cần kết nối DB. Ngoài identity, active/deleted, pair diagnostics và pattern qua đêm, có các ca ngoại lệ đầu/cuối giai đoạn, thiếu tuần, tie-break span/count/start và overnight sau chia giai đoạn. Test tham chiếu độc lập xét toàn bộ khoảng hợp lệ cho 255 tập ngày bất quy tắc và đối chiếu kết quả builder. Ca pattern qua đêm trước đó tái hiện Discontinue DEP `2026-11-03` thay vì đúng ARR +1 là `2026-11-04`.

Chạy trong thư mục `app`:

```bash
node --test src/lib/canonicalSeasonalRows.raw-flight.test.cjs
```

Kết quả trước sửa giai đoạn dài nhất: **13 pass, 4 fail** trên 17 test. Ca ngoại lệ đầu chuỗi nhận hai khoảng `11–13/10` và `20–27/10`, thay vì giữ ngoại lệ `11/10` riêng và giai đoạn Tue `13–27/10`. Hai test tie-break cũng thất bại trước sửa. Lỗi gom overnight một dòng ở lần kiểm chứng trước đã được tái hiện riêng: 8 pass, 1 fail.

Lệnh cuối cùng xuất file mẫu và chạy toàn bộ test liên quan với timezone khác:

```bash
node -e "process.env.TZ='Pacific/Honolulu'; process.env.EXPORT_EXCEL_PHASE_SAMPLE='../tmp/export_excel_longest_phases.xlsx'; process.env.EXPORT_EXCEL_PATTERN_SAMPLE='../tmp/export_excel_overnight_patterns.xlsx'; require('./src/lib/canonicalSeasonalRows.raw-flight.test.cjs')"
```

Kết quả cuối: **19 pass, 0 fail**, gồm 255 lịch đối chiếu trong test exhaustive-reference. Test xuất và đọc lại workbook; kiểm tra giai đoạn không giao nhau, không thêm/mất/trùng occurrence, tie-break, Effective/Discontinue +1, thứ +1 và tập ID đối ứng của từng pattern qua đêm. Ca rebuild giữ đúng 5 cặp trong dữ liệu ngoại lệ đầu/cuối; ca nhiều ngày trước đó vẫn giữ 6 cặp và 1 chuyến đơn ở boundary persistence. File mẫu giai đoạn dài nhất và file overnight được tạo thật. Không mở Excel desktop để kiểm tra trình bày bằng mắt.

| Pattern | ARR Effective–Discontinue | Thứ ARR | DEP Effective–Discontinue | Thứ DEP | STD |
| --- | --- | --- | --- | --- | --- |
| 1 | 25-Oct-26 – 2-Nov-26 | Sun, Mon | 26-Oct-26 – 3-Nov-26 | Mon, Tue | 02:00 |
| 2 | 27-Oct-26 – 3-Nov-26 | Tue | 28-Oct-26 – 4-Nov-26 | Wed | 03:00 |

Chuyến ARR đơn trùng số hiệu/giờ ngày 28-Oct-26 nằm trên dòng riêng, không kéo dài khoảng của ARR linked. Cả hai pattern giữ nguyên STA 23:00; DEP đổi giờ khiến cả hai phía được phân nhóm tương ứng, không làm mất occurrence.

File `tmp/export_excel_longest_phases.xlsx` được đọc lại từ đĩa bằng `XLSX.readFile`. Assertions xác minh đủ 25 header và 5 occurrence references; các dòng chính:

| Effective | Discontinue | Thứ | ARRFlight | Vai trò |
| --- | --- | --- | --- | --- |
| 11-Oct-26 | 11-Oct-26 | Sun | 621 | Ngoại lệ đầu |
| 13-Oct-26 | 27-Oct-26 | Tue | 621 | Giai đoạn dài nhất |
| 29-Oct-26 | 29-Oct-26 | Thu | 621 | Ngoại lệ cuối |


```bash
npx tsc --noEmit --incremental false
```

Kết quả: exit code 0, không có diagnostics.

```bash
npm run test:rules
```

Kết quả: thất bại tại `app/scripts/rule-regression-tests.cjs:1886`, assertion lời báo lỗi tên sheet không khớp thông báo tiếng Việt hiện tại. Vì suite dừng tại đây, không khẳng định full suite pass. Không sửa phần localization/assertion này ngoài phạm vi export.

Script integration `app/scripts/seasonal-import-export-roundtrip.mjs` được cập nhật để kiểm tra reference của cặp gốc và topology của dữ liệu sau parse/reimport, thay vì yêu cầu importer 25 cột tự khôi phục cặp cross-day. Không chạy integration DB trong phiên này; không thay đổi dữ liệu production.


## 7.1. Kiểm tra tương thích các luồng nghiệp vụ, Publish và Dashboard/Report

1. **Phát hiện và đã sửa tại biên lưu trữ source row (`app/src/lib/persistenceSchema.ts:174`):**
   - `SeasonalSchedulePage.tsx` gọi `buildPatternRowsFromRecords` (`buildCanonicalSeasonalRows`) sau các thao tác tạo mới, chỉnh sửa, xóa, link/unlink, rồi lưu `rows` qua `serializeSourceRowForPersistence`.
   - Trước khi sửa, `serializeSourceRowForPersistence` giữ lại `pairReferences` (metadata chỉ dành cho export Excel). Đã cập nhật hàm này để tách bỏ `pairReferences` trước khi persist, đồng thời thêm bài test thứ 20 trong `app/src/lib/canonicalSeasonalRows.raw-flight.test.cjs` (20/20 pass).
2. **Tạo mới, chỉnh sửa, xóa, link/unlink chuyến bay và Undo/Redo:**
   - Với các cặp qua đêm tách 2 dòng có `overnightLinkRowIndex` và `linkType = 'overnight'`, `flattenRowsToFlightRecords` (`app/src/lib/atomicSchedule.ts:551`) và `expandToFlightLegs` (`app/src/lib/parser.ts:268`) tự động ghép lại đúng cặp ARR/DEP và bảo toàn round-trip.
   - Đã chạy pass: `npm run test:seasonal-new-flight-creation` (9/9), `npm run test:atomic-flight` (6/6), `npm run test:seasonal-operational-m6-planning` (PGlite PASS), `npm run test:seasonal-operational-m6-undo` (PGlite PASS), `npm run test:seasonal-operational-m9-schedule` (PGlite PASS).
3. **Cơ chế công bố lịch bay sang vận hành (Publish):**
   - Luồng Publish (`seasonal_publish_operations_v1`, `commit_seasonal_publish_v1` trong `app/supabase/migrations/20261008090000_seasonal_publish_safety_v1.sql`) đọc trực tiếp từ bảng `public.seasonal_flight_drafts` và ghi sang `public.operational_flight_legs` (ánh xạ `linked_draft_id` -> `linked_leg_id`, `turnaround_id`, `link_type`, `pair_anchor_date`, `operational_date`), không phụ thuộc `canonicalSeasonalRows.ts`.
   - Xuất Excel phiên bản đã publish trong `SeasonalVersionHistoryModal.tsx:331` dùng chung `buildCanonicalSeasonalRows` + `exportCanonicalSeasonalRowsToExcel`.
   - Đã chạy pass: `npm run test:seasonal-operational-m7-publish` (PGlite PASS).
4. **Dashboard và Traffic Reports:**
   - Planning Dashboard (`planningDashboardSource.ts`), Operational Dashboard (`operationalDashboardAnalysis.ts`), Dashboard Excel Export (`dashboardReportExport.ts`) và Public Traffic Report (`reporting.canonical_flight_legs` / `get_public_traffic_report_v2`) đọc trực tiếp từ draft/operational records hoặc bảng reporting, hoàn toàn độc lập với `canonicalSeasonalRows.ts`.
   - Đã chạy pass các bộ kiểm chứng hành vi và hợp đồng dữ liệu: `operationalDashboardAnalysis.test.ts` (11/11), `dashboard-reporting-behavioral.cjs` (4/4), `test:operational-projection-runner` (9/9), `trafficReportContract.test.ts` + `trafficReportV2Contract.test.ts` + `trafficReportDataAdapter.test.ts` + `annualPassengerKpiContract.test.ts` + `trafficReportOperationalHours.test.ts` (41/41), `public_traffic_report_v1_pglite.mjs`, `traffic-report-edge-contract.test.mjs`, `traffic-report-isolation-test.mjs`, `dashboard-runner-contract.test.mjs` (3/3).
   - Lưu ý tồn tại sẵn ngoài phạm vi: `TrafficReportModePanel.source.test.ts` (nằm trong script `npm run test:dashboard-contract`) và các `.source.test.ts` giao diện đang fail do so khớp chuỗi text tiếng Việt tĩnh (`Pax bằng 0`, `aria-label="Bảng số liệu Report theo ngày"`) không khớp nội dung hiện tại của `TrafficReportModePanel.tsx`; tương tự `npm run test:rules` vẫn dừng ở `rule-regression-tests.cjs:1886` do chuỗi thông báo lỗi tên sheet tiếng Việt. Không sửa các test/UI localization ngoài phạm vi này.
## 8. Những luồng cố ý không thay đổi

- Daily Export tại `app/src/lib/dailyScheduleExport.ts` là báo cáo `Summary` 19 cột, mỗi dòng một chặng, không phải template ARR/DEP song song. Daily importer nhận template 43/44 cột khác. Không thay đổi báo cáo này để tránh làm đổi hợp đồng báo cáo vận hành. Kết quả xác minh trong báo cáo này áp dụng cho Export Excel lịch mùa 25 cột, không chứng nhận Daily Summary roundtrip.
- Không thay đổi `exporter.ts` legacy; callers xuất lịch mùa và lịch sử đang dùng canonical exporter đã sửa.
- Không thêm Registration hoặc bất kỳ migration nào.
- Không thêm cột kỹ thuật vào sheet template chính và không sửa importer để đọc sheet phụ.

## 9. Trạng thái review

- Đã map query/adapter liên kết DB mới: đủ trường, không cần sửa DB.
- Đã sửa tách/gộp và giữ format ngày hiện hành đồng nhất trên workbook.
- Đã verify ba kịch bản và biên ngày vận hành qua file XLSX thật.
- File để review: `tmp/export_excel_longest_phases.xlsx`, `tmp/export_excel_verified_sample.xlsx` và `tmp/export_excel_overnight_patterns.xlsx`.
- Điểm cần lưu ý khi review: scheduled date khác operational date theo cutoff; cross-day được link thủ công bằng sheet phụ, không tự động link bởi importer 25 cột hiện tại.
