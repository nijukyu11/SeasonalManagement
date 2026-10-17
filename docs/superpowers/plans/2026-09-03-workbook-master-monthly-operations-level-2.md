# Kế hoạch thực hiện Workbook Master và Báo cáo Tổng quan khai thác tháng - Mức 2

**Ngày lập:** 2026-09-03  
**Trạng thái:** Kế hoạch đề xuất, chưa triển khai code, chưa thay đổi schema hoặc production  
**Phạm vi sản phẩm:** trang Report tại `report.ahtops.xyz`  
**Tài liệu tham chiếu:** 6 workbook trong `docs/report_ref`, file `TỔNG QUAN KHAI THÁC THÁNG 9-2026.docx`, contract Report v2 và các ADR canonical reporting hiện hành

## 1. Kết luận kiến trúc

Triển khai một pipeline export dùng chung cho hai report type:

1. `MASTER_OPERATIONS`: workbook tổng hợp các nhóm thông tin đang nằm rải rác trong các workbook PivotTable mẫu.
2. `MONTHLY_OVERVIEW_L2`: báo cáo quản trị tháng mức 2, cung cấp số liệu, bảng, biểu đồ và các gợi ý định lượng để lập báo cáo “Tổng quan khai thác tháng”.

Hai report type dùng chung:

- nguồn Canonical Traffic Metrics Module qua Report Read Adapter;
- bộ lọc thực tế là `DateFrom` và `DateTo` theo `Ops Date`;
- lựa chọn “Cả mùa” chỉ là preset tự điền phạm vi ngày của mùa;
- Report Read Version gồm watermark, `data_as_of`, filter hash và metrics contract version;
- quy tắc `Pax NULL` là thiếu dữ liệu, không phải `0`;
- workbook renderer, metadata, audit receipt và quy tắc đặt tên file thống nhất.

Các workbook trong `docs/report_ref` là **template/semantic reference**, không phải nguồn dữ liệu production. Export không được đọc raw history hoặc tự chọn bản ghi từ các sheet `Data` cũ khi hệ thống đã có canonical reporting.

## 2. Định nghĩa phạm vi “Mức 2”

Trong kế hoạch này, `MONTHLY_OVERVIEW_L2` được hiểu là báo cáo quản trị bán tự động:

- tự động sinh toàn bộ số liệu định lượng đã có nguồn chuẩn;
- tự động tính so sánh MoM/YoY bằng backend/report model đã được kiểm thử;
- tự động dựng các bảng và biểu đồ phục vụ báo cáo Word;
- tự động nêu các biến động định lượng theo rule minh bạch, ví dụ “tăng nhiều nhất”, “giảm nhiều nhất”;
- các nhận định nghiệp vụ, nguyên nhân, hãng/chặng “khai thác mới”, “trở lại”, “tạm dừng” chỉ được xuất khi có nguồn sự kiện hoặc xác nhận của người phụ trách;
- nếu chưa có nguồn xác nhận, báo cáo ghi rõ `Chưa có dữ liệu nghiệp vụ được xác nhận`, không tự suy diễn từ việc số chuyến tăng hoặc giảm về 0.

Mức 2 chưa bao gồm:

- AI tự viết nhận định rồi coi là số liệu đã xác nhận;
- thay đổi schema để lưu nhận xét/sự kiện vận hành;
- công bố dữ liệu dòng hoặc raw leg trên trang public;
- tự động phát hành file Word cuối cùng mà không có bước duyệt nội dung nghiệp vụ.

## 3. Hiện trạng cần kế thừa

### 3.1. Nguồn và metric

- Canonical live leg store và overlay hiện tại sở hữu lifecycle active/deleted/duplicate.
- Canonical Traffic Metrics Module sở hữu Ops Date, A/D/all, flight count, Pax, coverage và trạng thái complete/partial/missing/future/zero.
- Report live v2 đã có Report Read Version để pin watermark và semantic `data_as_of` giữa overview, timeline, dimension và export.
- Frontend không được cộng lại metric backend đã sở hữu.

### 3.2. Export hiện tại

`app/src/lib/trafficReportExcelExport.ts` hiện tạo workbook mới bằng SheetJS với 6 sheet:

- `Tổng quan`;
- `Theo ngày`;
- `Cơ cấu`;
- `24 khung giờ`;
- `Giờ cao điểm tháng`;
- `Thứ trong tuần`.

Export hiện tại đã có dữ liệu nền cần thiết nhưng chưa khớp workbook mẫu về:

- cấu trúc sheet chuyên biệt;
- style, merge cell, number format, print area và chart;
- comparison table MoM/YoY theo từng dimension;
- cấu trúc tuần nghiệp vụ Thứ Sáu-Thứ Năm;
- tần suất, 30 phút, cấu hình tàu bay và các section phục vụ báo cáo tháng;
- native PivotTable/pivot cache;
- metadata/receipt đầy đủ trong file.

Endpoint Report v2 `/export` hiện trả aggregate CSV. File XLSX 6 sheet được dựng ở frontend từ bundle đang xem. Pipeline mới phải tránh hai đường export có semantics khác nhau.

### 3.3. Bộ lọc hiện tại

UI hiện hỗ trợ date range và các preset `7d`, `30d`, `ytd`. Chưa có:

- preset “Cả mùa” lấy ngày từ season catalog;
- chọn report type/template;
- month picker chuyên dụng cho `MONTHLY_OVERVIEW_L2`;
- trạng thái draft/final cho tháng chưa hoàn tất.

## 4. Mapping workbook mẫu sang Workbook Master

| Workbook mẫu | Nội dung chính cần kế thừa | Sheet đích trong Master | Ghi chú |
|---|---|---|---|
| `BaoCaoSanLuong.xlsm` | TOTAL, tháng, tuần, phân tích hãng/quốc gia, chart | `Tổng quan`, `Theo thời gian`, `Hãng hàng không`, `Thị trường` | Giữ tuần Thứ Sáu-Thứ Năm như một loại tuần nghiệp vụ riêng |
| `SanLuong_Country_2026.xlsx` | Quốc gia -> chặng -> hãng theo tháng | `Thị trường`, `Chặng bay` | Country chưa map phải vào `Unknown/Chưa xác định` |
| `SanLuong_S26 - Copy.xlsm` | Airline, Country, Routes, Frequency, Month, PeakHour, Per30min, ACType, Config, Data | Toàn bộ nhóm sheet Master | Dùng làm reference bao phủ rộng nhất, không dùng dữ liệu trong file làm production truth |
| `SanLuong_S26.xlsm` | Cùng họ S26 nhưng khác phạm vi/cache/range | Chỉ dùng đối chiếu | Không trộn cấu trúc với bản `Copy` nếu chưa chốt template authority |
| `SanLuong_Week_S26.xlsx` | Tuần/ngày, hãng, quốc gia, route, peak hour, chi tiết | `Theo thời gian`, `Hãng`, `Thị trường`, `Giờ khai thác` | Phải ghi rõ chuẩn tuần, không gọi chung “Week” |
| `SanLuongAPR.xlsx` | Báo cáo tháng 4 và tuần 26/4-2/5 | `Theo thời gian`, `Hãng`, `Thị trường` | Dùng làm golden sample cho range cắt qua hai tháng |

Không sửa trực tiếp bất kỳ file nào trong `docs/report_ref`. Template production phải là bản dẫn xuất có version và checksum riêng.

## 5. Cấu trúc Workbook Master đề xuất

### 5.1. Danh sách sheet public/aggregate

1. `Hướng dẫn`
   - Mục đích, phạm vi, cách đọc Pax/coverage.
   - Giải thích tuần ISO và tuần nghiệp vụ.
   - Cảnh báo dữ liệu partial/future/missing.

2. `Thông tin báo cáo`
   - Report type, template version.
   - `DateFrom`, `DateTo`, season preset nếu có.
   - Generated at, `data_as_of`, source watermark, filter hash.
   - Metrics contract version, request id, checksum.

3. `Tổng quan`
   - Tổng chuyến, ARR, DEP, Pax đã báo cáo.
   - Pax coverage numerator/denominator và trạng thái.
   - Bình quân chuyến/ngày.
   - Kỳ so sánh trước và cùng kỳ năm trước khi contract hỗ trợ.
   - Ngày cao điểm.

4. `Theo ngày`
   - Ops Date, thứ, ARR, DEP, tổng chuyến, Pax và coverage.
   - Ngày thiếu nguồn giữ trạng thái missing, không điền 0.

5. `Theo tháng`
   - Tháng, ARR, DEP, tổng chuyến, Pax, bình quân/ngày.
   - MoM/YoY và tỷ lệ thay đổi có kiểm soát mẫu số 0/null.

6. `Theo tuần`
   - Hai bảng tách biệt: tuần ISO Thứ Hai-Chủ Nhật và tuần nghiệp vụ Thứ Sáu-Thứ Năm.
   - Mỗi dòng ghi rõ `WeekFrom`/`WeekTo`, không chỉ ghi số tuần.

7. `Hãng hàng không`
   - Hãng, ARR, DEP, tổng chuyến, Pax, flight share, Pax share và coverage.
   - Current, previous, year-ago, delta và delta %.

8. `Thị trường`
   - Quốc gia/`Unknown`, chuyến, Pax, tỷ trọng và so sánh kỳ.
   - Có subtotal/total reconciliation.

9. `Chặng bay`
   - Route, airline nếu contract cho phép aggregate an toàn, ARR/DEP/all, Pax và so sánh.

10. `Giờ khai thác`
    - 24 khung giờ ARR/DEP.
    - Bảng 30 phút khi source contract có bucket 30 phút.
    - Giờ cao điểm theo tháng và số chuyến bình quân/ngày.

11. `Tần suất`
    - Hãng/chặng/chuyến thường lệ theo thứ trong tuần khi nguồn regular-flight aggregate hiện tại đủ.
    - Không suy ra lịch khai thác chính thức chỉ từ một vài occurrence.

12. `Tàu bay`
    - Aircraft group, aircraft type và config khi contract có dữ liệu.

13. `Kiểm soát dữ liệu`
    - Tổng A + D so với all.
    - Tổng dimension so với KPI.
    - Unknown country, missing Pax, suppressed cells.
    - Số duplicate candidates đã quarantine.
    - Trạng thái projection/read version.

### 5.2. Không đưa vào workbook public

- leg id, raw flight row, raw history, deleted row, overlay internals;
- Pivot source dạng chi tiết có thể dùng để suy ngược các cell bị suppression;
- flight number/exact schedule nếu public contract không cho phép;
- sheet `Data` chỉ bị ẩn nhưng vẫn chứa raw data.

Nếu cần bản Master nội bộ có `Data` và native PivotTable refresh-on-open, phải tạo report type riêng `MASTER_OPERATIONS_INTERNAL`, đặt sau authentication/authorization và có phê duyệt data contract. Không dùng hidden sheet như một cơ chế bảo mật.

## 6. Cấu trúc Báo cáo Tổng quan khai thác tháng - Mức 2

### 6.1. Sheet đầu ra

1. `Tóm tắt tháng`
   - KPI tháng hiện tại.
   - MoM, YoY, bình quân/ngày.
   - Top tăng/giảm có số tuyệt đối và tỷ lệ.
   - Badge `FINAL` hoặc `DRAFT/PARTIAL`.

2. `Sản lượng chuyến bay`
   - Bốn kỳ chuẩn: tháng trước năm trước, tháng báo cáo năm trước, tháng trước hiện tại, tháng báo cáo hiện tại.
   - ARR, DEP, tổng, số ngày, trung bình/ngày.
   - Bảng giải thích mẫu số và coverage.

3. `Ngày cao điểm`
   - Top ngày theo total/ARR/DEP.
   - Giá trị, thứ trong tuần, chênh lệch so với bình quân tháng.

4. `Giờ cao điểm`
   - 24 giờ và top bucket ARR/DEP.
   - Giá trị bình quân/ngày, không dùng period total để mô tả “khoảng X chuyến/ngày”.
   - Chưa tự gộp thành dải giờ liên tiếp cho đến khi quy tắc nghiệp vụ được duyệt.

5. `Chuyến bay sớm`
   - Danh sách aggregate/candidate theo cutoff được duyệt.
   - Chưa xuất khi chưa chốt cutoff riêng cho ARR và DEP hoặc khi public contract không có dữ liệu phù hợp.

6. `Hãng hàng không`
   - Current, previous, year-ago, delta, delta %, share.
   - Top tăng/giảm.
   - “Khai thác trở lại” chỉ xuất từ nguồn sự kiện đã xác nhận.

7. `Thị trường`
   - Hai bảng YoY và MoM theo quốc gia.
   - Tổng phải reconciliation với KPI, bao gồm `Unknown`.
   - Hai biểu đồ: biến động MoM và so sánh thị phần current/year-ago.

8. `Chặng bay`
   - Bảng 4 kỳ tương tự file tham chiếu.
   - Delta MoM/YoY và tỷ lệ tăng trưởng.
   - Candidate mới/trở lại/tạm dừng tách riêng khỏi kết luận đã xác nhận.

9. `Ghi chú nghiệp vụ`
   - Trường nhập/xuất có cấu trúc: loại sự kiện, hãng, route, giai đoạn, tần suất, nguồn xác nhận, người duyệt.
   - Nếu pipeline chưa có annotation source, để trống kèm trạng thái rõ ràng; không tạo mock content.

10. `Kiểm soát`
    - Metadata, coverage, tổng đối chiếu, warning và publish readiness.

### 6.2. Mapping với file Word tham chiếu

| Phần trong file Word | Mức tự động hóa | Nguồn dự kiến |
|---|---|---|
| Đoạn tổng quan đầu báo cáo | Bán tự động | KPI + MoM/YoY + top contributor; câu chữ cuối cần duyệt |
| I. Số lượng chuyến bay đi và đến | Tự động | KPI/timeline canonical |
| Ngày cao điểm | Tự động | Daily timeline |
| Khung giờ cao điểm | Tự động ở cấp bucket; gộp dải giờ cần rule | Peak-hour aggregate |
| Chuyến bay khai thác sớm | Chưa tự động hoàn toàn | Cần cutoff và aggregate/detail contract phù hợp |
| II. Hãng hàng không | Số liệu tự động; lifecycle cần xác nhận | Airline aggregate + event source |
| III. Thị trường | Tự động | Country aggregate + Unknown |
| IV. Chặng bay | Delta tự động; mới/trở lại/dừng cần xác nhận | Route aggregate + event source |
| Nhận định ảnh hưởng năng lực nhà ga | Thủ công/được duyệt | Không suy ra từ traffic volume nếu chưa có capacity contract |

File Word tham chiếu có 10 bảng và 2 chart nhúng. Hai chart cần được cover trong báo cáo mức 2:

- biểu đồ biến động sản lượng chuyến bay theo tháng/MoM;
- biểu đồ so sánh thị phần chuyến bay theo quốc gia giữa tháng báo cáo và cùng kỳ năm trước.

## 7. Quy tắc kỳ báo cáo và comparison

### 7.1. Date range là authority

- Request cuối cùng luôn có `from` và `to` theo `Ops Date`.
- `Cả mùa`: chọn season, UI lấy ngày bắt đầu/kết thúc và điền `from/to`.
- `Khoảng ngày tùy chỉnh`: người dùng nhập trực tiếp `from/to`.
- Metadata giữ `season_code` chỉ để audit preset, không dùng thay thế date filter.

### 7.2. Báo cáo tháng

- Input chính là `month=YYYY-MM`, được normalize thành ngày đầu và ngày cuối tháng.
- Mặc định chỉ cho trạng thái `FINAL` khi tháng đã hoàn tất và coverage đạt điều kiện.
- Nếu tháng hiện tại chưa hoàn tất, vẫn có thể xuất `DRAFT/PARTIAL` nhưng phải ghi rõ ngày dữ liệu cuối cùng.
- `previous`: tháng lịch ngay trước đó.
- `year_ago`: cùng tháng năm trước.
- Không so sánh phần tháng với cả tháng mà không ghi rõ phạm vi tương đương.

### 7.3. Tuần

- Public Report hiện dùng semantics calendar/ISO cho một số biểu đồ.
- Workbook mẫu có tuần nghiệp vụ Thứ Sáu-Thứ Năm.
- Master phải hỗ trợ hai trường rõ ràng: `ISO Week` và `Business Week (Fri-Thu)`; không ghi đè một loại lên loại kia.

## 8. UI đề xuất tại report.ahtops.xyz

Thêm action `Xuất báo cáo Excel` mở dialog/drawer có:

1. `Loại báo cáo`
   - `Workbook tổng hợp khai thác`;
   - `Tổng quan khai thác tháng - Mức 2`.

2. `Phạm vi`
   - `Cả mùa`;
   - `Khoảng ngày tùy chỉnh`;
   - với báo cáo tháng: `Tháng báo cáo`.

3. `Cả mùa`
   - season selector;
   - hiển thị ngày đã resolve;
   - người dùng vẫn nhìn thấy `Từ ngày` và `Đến ngày` ở chế độ read-only.

4. `Khoảng ngày tùy chỉnh`
   - `Từ ngày`;
   - `Đến ngày`;
   - validation min/max và from <= to.

5. `Tùy chọn`
   - múi giờ `local/UTC` khi report hỗ trợ;
   - comparison previous/year-ago;
   - chỉ bật các option thuộc allowlist của report type.

6. `Trạng thái export`
   - đang chuẩn hóa phạm vi;
   - đang chụp Report Read Version;
   - đang tạo workbook;
   - hoàn tất/lỗi/version changed.

Không để frontend tự cộng KPI hoặc tự dựng comparison từ các bảng đang render. UI chỉ gửi request và tải artifact đã được renderer xác nhận.

## 9. API và contract đề xuất

### 9.1. Request

```json
{
  "report_type": "MASTER_OPERATIONS",
  "period": {
    "mode": "season",
    "season_code": "S26",
    "from": "2026-03-29",
    "to": "2026-10-24"
  },
  "comparison": ["previous", "year_ago"],
  "time_basis": "local",
  "template_version": "master-v1"
}
```

Với báo cáo tháng:

```json
{
  "report_type": "MONTHLY_OVERVIEW_L2",
  "period": {
    "mode": "month",
    "month": "2026-09",
    "from": "2026-09-01",
    "to": "2026-09-30"
  },
  "comparison": ["previous", "year_ago"],
  "template_version": "monthly-l2-v1"
}
```

### 9.2. Normalization

Backend phải:

- allowlist report type/template/version;
- kiểm tra `from/to` khớp season/month preset;
- canonicalize filters;
- chụp hoặc validate Report Read Version;
- thực hiện mọi query cần thiết trên cùng watermark và semantic `data_as_of`;
- từ chối tạo mixed-version workbook;
- không nhận đường dẫn template, formula, macro hoặc sheet tùy ý từ client.

### 9.3. Export execution

Pipeline:

```text
Export request
  -> normalize date range/preset
  -> acquire fixed Report Read Version
  -> query canonical aggregate resources
  -> build report-neutral workbook model
  -> render selected template
  -> structural/data validation
  -> write receipt/checksum
  -> stream XLSX download
```

Nếu synchronous execution vượt latency budget, chuyển sang job có `job_id`, trạng thái và download URL ngắn hạn. Không để client giữ raw payload lớn rồi tự dựng workbook.

### 9.4. Metadata/audit tối thiểu

- report type và template version;
- normalized `from/to` và preset source;
- comparison ranges;
- generated at và `data_as_of`;
- source watermark/data version;
- metrics contract version;
- filter hash/request hash;
- Pax coverage;
- warning/partial state;
- artifact SHA-256;
- executor version/release id.

## 10. Chiến lược renderer

### 10.1. Public aggregate workbook - bắt buộc

Dùng template dẫn xuất, chỉ chứa bảng aggregate an toàn:

- giữ style, width, merge, print settings và chart layout;
- ghi dữ liệu vào Excel Table/range động;
- cập nhật formula/chart reference theo table/name, không dùng fixed range như `A1:P25520`;
- không nhúng raw `Data`;
- công thức chỉ làm presentation/reconciliation, không sở hữu metric nghiệp vụ.

### 10.2. Native PivotTable refresh-on-open - tùy chọn nội bộ

Nếu người dùng cần đúng native PivotTable như file mẫu:

- tạo một template nội bộ đã được sanitize/version;
- patch OOXML có chủ đích, không round-trip toàn workbook qua thư viện làm mất pivot/VBA;
- thay `Data/Table1`, cập nhật table ref động;
- giữ pivot cache/table/chart relationships;
- bật `refreshOnLoad` và full calculation on open;
- xác nhận bằng Excel Desktop mở file và `Refresh All`;
- chỉ phát hành qua kênh authenticated vì workbook chứa dữ liệu nguồn có thể truy cập được.

Không triển khai native pivot public nếu nguồn Pivot cho phép truy cập raw/low-cell dữ liệu hoặc vượt privacy suppression.

### 10.3. Template versioning

Tạo template dẫn xuất ở vị trí riêng, ví dụ:

```text
app/report-templates/master-operations/v1/
app/report-templates/monthly-overview-l2/v1/
```

Mỗi version có:

- file template;
- manifest sheet/name/header mapping;
- source reference fingerprints;
- renderer compatibility version;
- checksum;
- golden structural assertions.

Không sửa file gốc trong `docs/report_ref`.

## 11. Report-neutral workbook model

Tạo model chung để backend metric và renderer tách biệt:

```text
WorkbookReportModel
  metadata
  period
  comparisonPeriods
  kpis
  timelineDaily
  timelineMonthly
  timelineIsoWeek
  timelineBusinessWeek
  airlineRows
  countryRows
  routeRows
  peakHourRows
  halfHourRows?
  dayOfWeekRows
  aircraftRows
  frequencyRows?
  eventAnnotations?
  qualityChecks
```

Nguyên tắc:

- null giữ nguyên null;
- mỗi metric có status/coverage khi cần;
- dimension row có key ổn định, không join bằng label hiển thị;
- percent lưu dạng số thập phân và format `0.0%`;
- ngày lưu dạng date value, hiển thị `dd/mm/yyyy`;
- count/Pax dùng number format `#,##0`;
- không hard-code số liệu mẫu trong renderer/test production path.

## 12. Phần dữ liệu còn thiếu hoặc cần contract bổ sung

Các nội dung sau chưa được current public aggregate contract bảo đảm đầy đủ:

| Nhu cầu | Trạng thái | Hướng xử lý |
|---|---|---|
| Bucket 30 phút | Chưa có trong Traffic Report bundle hiện tại | Bổ sung aggregate resource nếu source có phút và privacy cho phép |
| Flight/route frequency chi tiết | Có regular-flight summary ở peak-hour nhưng chưa phải bảng frequency tổng quát | Thiết kế aggregate contract riêng hoặc giới hạn scope |
| Aircraft config | Có aircraft group/type, config chưa chắc có public contract | Không suy ra; cần xác nhận source/allowlist |
| Chuyến bay sớm | Chưa chốt cutoff và public detail | Chốt rule rồi bổ sung aggregate an toàn |
| Hãng/chặng mới, trở lại, tạm dừng | Aggregate không chứng minh lifecycle business | Cần event source hoặc review workflow |
| Lý do tăng/giảm | Không có trong metric | Nhập/duyệt thủ công, không để AI khẳng định |
| Capacity/ùn tắc nhà ga | Không có capacity contract | Không phát biểu tự động |
| Native Pivot public | Mâu thuẫn với aggregate-only/privacy | Chỉ cân nhắc bản authenticated/internal |

Không tạo schema, migration hoặc new report event type trước khi các mục này được phê duyệt.

## 13. Phân kỳ triển khai

### Phase 0 - Chốt quyết định và baseline

- Fingerprint toàn bộ workbook mẫu và template dẫn xuất.
- Chốt template authority giữa `SanLuong_S26 - Copy.xlsm` và `SanLuong_S26.xlsm`.
- Chốt public aggregate Master hay internal Pivot Master, hoặc cả hai.
- Chốt định nghĩa peak-hour, early-flight cutoff, tuần nghiệp vụ và publish readiness.
- Chụp baseline export hiện tại: sheet, row count, API payload, latency và file size.
- Không thay đổi production.

**Gate 0:** các open decisions ở mục 18 được xác nhận.

### Phase 1 - Contract và characterization tests

- Viết characterization cho export 6 sheet hiện tại.
- Định nghĩa `TrafficWorkbookExportRequest`, `WorkbookReportModel`, report type registry và filename policy.
- Viết mapping manifest cho hai report type.
- Viết contract test cho season/custom/month normalization.
- Chứng minh cùng Report Read Version cho toàn bộ resource của một export.

**Gate 1:** chưa render template nhưng model đối chiếu đúng với Report v2.

### Phase 2 - UI chọn report và date range

- Thêm dialog/drawer export.
- Thêm `Cả mùa` và season selector.
- Giữ date range là state thực tế; season chỉ điền date.
- Thêm month picker cho `MONTHLY_OVERVIEW_L2`.
- Thêm loading/error/version-changed/download states.

**Gate 2:** URL/filter hiện tại không bị thay đổi ngoài ý muốn; mobile/keyboard acceptance pass.

### Phase 3 - Public Workbook Master

- Tạo template dẫn xuất public không chứa raw Data.
- Render 13 sheet aggregate.
- Áp dụng format, width, merge, table, freeze pane, print setup và chart.
- Bổ sung data-control sheet và metadata receipt.
- Đối chiếu totals với API/direct canonical query trên staging.

**Gate 3:** sheet/header/format/reconciliation pass; workbook không chứa raw history.

### Phase 4 - Monthly Overview L2

- Tạo model current/previous/year-ago.
- Dựng 10 sheet theo mục 6.
- Dựng hai chart tương ứng file Word.
- Sinh highlight định lượng theo rule deterministic.
- Tách candidate lifecycle khỏi event đã xác nhận.
- Gắn `FINAL`/`DRAFT/PARTIAL` theo coverage và period completeness.

**Gate 4:** số liệu trong các bảng có thể dùng trực tiếp để lập file Word mà không chép lại từ nhiều workbook.

### Phase 5 - Template-preserving Pivot nội bộ, nếu được duyệt

- Spike OOXML trên bản copy của template.
- Thay Data Table động và giữ pivot/chart/VBA relationships.
- Mở bằng Excel Desktop, refresh và lưu thử.
- Kiểm tra file size, refresh time, corruption prompt và formula errors.
- Chỉ tích hợp vào authenticated export path sau privacy approval.

**Gate 5:** Excel Desktop refresh acceptance; không đưa bản internal vào public route.

### Phase 6 - Staging, rollout và soak

- Feature flag hai report type mới.
- Staging comparison với workbook mẫu và file Word tháng đã chọn.
- Kiểm tra public download, cache/no-store, filename, checksum và retry.
- Rollout additive; giữ export 6 sheet cũ làm rollback trong soak window.
- Chỉ production deploy sau phê duyệt riêng.

## 14. File/module dự kiến tác động khi implement

### Modify

- `app/src/lib/trafficReportContract.ts`
- `app/src/lib/trafficReportV2Contract.ts`
- `app/src/lib/trafficReportDataAdapter.ts`
- `app/src/lib/trafficReportExcelExport.ts`
- `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportFilters.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportPresentation.source.test.ts`
- `app/supabase/functions/traffic-report/index.ts` nếu cần export executor/resource aggregate mới
- `app/scripts/traffic-report-edge-contract.test.mjs`
- `app/supabase/tests/public_traffic_report_v1_pglite.mjs` nếu contract query thay đổi
- `docs/runbooks/public-traffic-report-deploy.md`

### Add dự kiến

- report type/export request contract;
- report-neutral workbook model builder;
- Master workbook renderer;
- Monthly Overview L2 model/renderer;
- template manifests và template dẫn xuất;
- structural/golden workbook tests;
- export receipt/checksum helper;
- browser/source tests cho export dialog.

Không tạo migration trong plan. Nếu Phase 12 xác định cần aggregate resource hoặc event annotation persistence mới, phải lập contract/migration plan riêng và xin xác nhận.

## 15. Test matrix bắt buộc

### Mapping/template

- report type -> đúng template/version;
- sai/unknown template bị từ chối;
- workbook mẫu fingerprint drift tạo cảnh báo, không âm thầm dùng template mới;
- sheet order/name/header đúng manifest.

### Date filter

- cả mùa resolve đúng `from/to`;
- custom range dùng đúng inclusive Ops Date;
- single-day, cross-month, cross-season, cross-year;
- month normalize đúng số ngày, kể cả tháng 2 năm nhuận;
- partial month gắn `DRAFT/PARTIAL`.

### Data correctness

- all = A + D khi contract cho phép đối chiếu;
- current/previous/year-ago dùng đúng kỳ;
- row count mỗi sheet khớp resource;
- dimension totals reconcile với KPI hoặc có `Unknown/suppressed` explanation;
- không lấy deleted/raw history/duplicate candidates;
- watermark thay đổi trong lúc export phải fail/restart, không tạo mixed artifact.

### Pax/null

- Pax null xuất ô trống/`—` theo vị trí trình bày;
- true-zero xuất `0`;
- percentage/delta không tính khi denominator/null không hợp lệ;
- coverage được hiển thị cạnh Pax.

### Excel structure/format

- date là typed date, format `dd/mm/yyyy`;
- count/Pax format `#,##0`;
- percent format `0.0%`;
- width, wrap, merge, freeze pane, print area đúng manifest;
- table/range động, không có fixed row cap;
- chart series/category reference đúng table/name;
- scan lỗi `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`.

### Privacy/security

- public workbook không chứa raw leg/history/deleted rows;
- không có hidden raw sheet, external link, credential, local path hoặc macro;
- suppression không bị phá bằng subtotal/A-D subtraction;
- formula injection được escape ở mọi text cell;
- download dùng `no-store` và filename allowlist.

### Native Pivot/internal, nếu triển khai

- VBA/pivot/chart OOXML parts còn nguyên;
- Data Table ref khớp row count thực tế;
- pivot `refreshOnLoad` được bật;
- Excel Desktop mở không có repair prompt;
- Refresh All cập nhật đúng totals;
- file không được tải từ anonymous/public route.

## 16. Verification dự kiến

Chạy từ `app`:

```powershell
npm run test:traffic-report-contract
npm run build:traffic-report
npx tsc --noEmit --pretty false
npm run lint
```

Bổ sung targeted test command cho workbook contract/renderer khi code tồn tại. Build pass không thay thế:

- direct data reconciliation;
- structural inspection của file XLSX/OOXML;
- visual review từng sheet;
- Excel Desktop refresh acceptance cho native Pivot;
- staging/public download acceptance.

Không dùng mock data để tuyên bố khớp production. Fixture chỉ dùng cho edge-case/contract test; nghiệm thu số liệu phải dùng staging/production-derived canonical data tại cùng watermark và `data_as_of`.

## 17. Rollout và rollback

### Rollout

1. Additive code/template, feature flag off.
2. Test trên clone/staging với Report Read Version cố định.
3. Bật nội bộ cho người kiểm tra.
4. So sánh file mới với workbook mẫu và báo cáo tháng được chọn.
5. Bật public aggregate export.
6. Soak, theo dõi latency/error/file size/version-changed.
7. Native Pivot nội bộ là release riêng.

### Rollback

- tắt report type mới bằng feature flag;
- giữ action export cũ;
- giữ template version trước và receipt/checksum;
- không rollback bằng cách đổi canonical data hoặc sửa workbook mẫu;
- nếu renderer lỗi, dừng tạo artifact mới, các file đã tải vẫn giữ audit metadata.

## 18. Các quyết định cần chốt trước implementation

| Quyết định | Khuyến nghị | Lý do |
|---|---|---|
| Master public hay internal Pivot | Public aggregate trước; internal Pivot là release riêng | Raw Data trong Pivot không phù hợp anonymous public report |
| Template authority S26 | Dùng `SanLuong_S26 - Copy.xlsm` làm reference chính, file còn lại chỉ đối chiếu | Bao phủ nhiều nhóm Pivot hơn; tránh trộn hai cache/range mâu thuẫn |
| Chuẩn tuần | Xuất cả ISO và Thứ Sáu-Thứ Năm, ghi rõ range | Đáp ứng cả contract mới và workbook legacy |
| Peak-hour narrative | Hiển thị top bucket + bình quân/ngày trước; chưa tự gộp dải giờ | File Word chưa định nghĩa thuật toán gộp |
| Early-flight cutoff | Chờ nghiệp vụ chốt ARR/DEP | Mẫu có giờ 03:15-06:40 nên không thể suy ra một cutoff chắc chắn |
| Lifecycle hãng/chặng | Event source hoặc review workflow | Sản lượng 0/tăng lại không đủ chứng minh mới/trở lại/dừng |
| Annotation storage | Chưa tạo schema; đầu tiên xuất sheet ghi chú có cấu trúc | Tuân thủ ràng buộc không đổi data contract lớn khi chưa xác nhận |
| Final Word generation | Sau khi L2 workbook và annotation contract ổn định | Tránh tự động hóa câu chữ trước khi số liệu/quy tắc được duyệt |

Một mâu thuẫn cần xác minh trong file Word tham chiếu: KPI tổng tháng 9/2026 là `3.898` chuyến nhưng bảng thị trường YoY cộng `3.897`. Implementation không được ép hai số khớp bằng cách bỏ dữ liệu; phải đưa `Unknown/Chưa xác định` vào reconciliation hoặc ghi rõ nguyên nhân đã xác minh.

## 19. Definition of Done

### Workbook Master

- Người dùng chọn được cả mùa hoặc custom date range.
- Workbook dùng đúng normalized `Ops Date` range và một Report Read Version.
- Bao phủ các nhóm thông tin chính của 6 workbook mẫu bằng các sheet đã định nghĩa.
- Workbook public không chứa raw/history/duplicate rows.
- Pax null/zero/coverage đúng semantics.
- Style, format, table, chart và print layout đạt manifest/golden acceptance.
- Metadata/receipt đủ để tái đối chiếu nguồn.

### Monthly Overview L2

- Xuất được một tháng hoàn chỉnh hoặc draft partial có nhãn rõ ràng.
- Có current, previous và year-ago theo đúng kỳ.
- Có số liệu phục vụ các phần I-IV của file Word ở mức contract hiện có.
- Có hai chart chính, bảng market/route/airline, ngày và giờ cao điểm.
- Nội dung lifecycle/nguyên nhân không được tự khẳng định khi chưa có nguồn xác nhận.
- Tổng KPI/dimension/Unknown/Pax coverage có kiểm soát và warning.

### Chất lượng và vận hành

- Test mapping, date filters, sheet/header/row count, format, null, duplicate/raw exclusion pass.
- Structural và visual review pass; native Pivot nếu có phải pass Excel Desktop refresh.
- Staging reconciliation không có chênh lệch chưa giải thích.
- Production rollout có phê duyệt riêng, feature flag và rollback đã thử.

